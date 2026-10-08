import { i18n } from "@/i18n/i18next";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ListTodo } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { usePaneContext } from "@/panels/pane-context";
import { definePanel } from "@/panels/panel-registry";
import { collectAllTabs, useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSessionStore } from "@/stores/session-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import { SwarmTaskSurface } from "./task-surface";
import { openSwarmTaskSurfaceState, type SwarmTaskReference } from "./task-model";
import { buildPanelInstanceKey } from "@/panels/panel-instance-attributes";
import {
  ensureSwarmTasksTab,
  openSwarmReference,
  readSwarmTaskSelection,
  setSwarmTaskSelection,
  getFocusedOrdinaryTab,
  type SwarmTaskSelection,
} from "./navigation";

const ThemedListTodo = withUnistyles(ListTodo);

// Tab identity remains stable when workspace chrome replaces its responsive host.
const retainedTasks = new Map<
  string,
  {
    serverId: string;
    workspaceId: string;
    workspaceKey: string;
    tabId: string;
    workspaceObserved: boolean;
    state: ReturnType<typeof openSwarmTaskSurfaceState>;
  }
>();
let stopLayoutObserver: (() => void) | undefined;
let stopWorkspaceObserver: (() => void) | undefined;

function closeRetainedTasks(key: string) {
  retainedTasks.get(key)?.state.close();
  retainedTasks.delete(key);
  if (retainedTasks.size === 0) {
    stopLayoutObserver?.();
    stopWorkspaceObserver?.();
    stopLayoutObserver = undefined;
    stopWorkspaceObserver = undefined;
  }
}

// Called only by the committed tab adapter. An abandoned render never registers state.
function retainTasksState(serverId: string, workspaceId: string, tabId: string) {
  const workspaceKey = `${serverId}:${workspaceId}`;
  const initialLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  if (!initialLayout || !collectAllTabs(initialLayout.root).some((tab) => tab.tabId === tabId))
    return null;
  const initialSession = useSessionStore.getState().sessions[serverId];
  const workspaceExists = Boolean(
    resolveWorkspaceMapKeyByIdentity({ workspaces: initialSession?.workspaces, workspaceId }),
  );
  if (initialSession?.hasHydratedWorkspaces && !workspaceExists) return null;
  const key = buildPanelInstanceKey({ serverId, workspaceId, tabId });
  let entry = retainedTasks.get(key);
  if (!entry) {
    entry = {
      serverId,
      workspaceId,
      workspaceKey,
      tabId,
      workspaceObserved: workspaceExists,
      state: openSwarmTaskSurfaceState(),
    };
    retainedTasks.set(key, entry);
  }
  if (!stopLayoutObserver) {
    stopLayoutObserver = useWorkspaceLayoutStore.subscribe((next, before) => {
      for (const [entryKey, retained] of retainedTasks) {
        const oldLayout = before.layoutByWorkspace[retained.workspaceKey];
        const layout = next.layoutByWorkspace[retained.workspaceKey];
        if (layout === oldLayout) continue;
        if (oldLayout && !layout) closeRetainedTasks(entryKey);
        else if (retained.tabId && oldLayout && layout) {
          const existed = collectAllTabs(oldLayout.root).some(
            (tab) => tab.tabId === retained.tabId,
          );
          const exists = collectAllTabs(layout.root).some((tab) => tab.tabId === retained.tabId);
          if (existed && !exists) closeRetainedTasks(entryKey);
        }
      }
    });
    stopWorkspaceObserver = useSessionStore.subscribe((next, before) => {
      for (const [entryKey, retained] of retainedTasks) {
        const oldSession = before.sessions[retained.serverId];
        const session = next.sessions[retained.serverId];
        if (!session) continue;
        if (
          oldSession?.workspaces === session.workspaces &&
          oldSession.hasHydratedWorkspaces === session.hasHydratedWorkspaces
        )
          continue;
        const exists = resolveWorkspaceMapKeyByIdentity({
          workspaces: session.workspaces,
          workspaceId: retained.workspaceId,
        });
        if (exists) retained.workspaceObserved = true;
        else if (retained.workspaceObserved && session.hasHydratedWorkspaces)
          closeRetainedTasks(entryKey);
      }
    });
  }
  return entry.state;
}

export function SwarmTasksContent({
  serverId,
  workspaceId,
  tabId,
  keyboardInsetHandled = false,
  presentation = "explorer",
}: {
  serverId: string;
  workspaceId: string;
  tabId?: string;
  keyboardInsetHandled?: boolean;
  presentation?: "main" | "explorer";
}) {
  const workspaceKey = `${serverId}:${workspaceId}`;
  const layout = useWorkspaceLayoutStore((state) => state.layoutByWorkspace[workspaceKey]);
  const backingTab = useWorkspaceLayoutStore((state) => {
    const storedLayout = state.layoutByWorkspace[workspaceKey];
    return (
      storedLayout &&
      collectAllTabs(storedLayout.root).find((tab) =>
        tabId
          ? tab.tabId === tabId
          : tab.target.kind === "swarm_tasks" && tab.target.instance === "explorer",
      )
    );
  });
  const selection = useMemo(() => readSwarmTaskSelection(backingTab?.state), [backingTab?.state]);
  const backingTabId = backingTab?.tabId;
  const retainedKey = backingTabId
    ? buildPanelInstanceKey({ serverId, workspaceId, tabId: backingTabId })
    : null;
  const [attached, setAttached] = useState<{
    key: string;
    state: ReturnType<typeof openSwarmTaskSurfaceState>;
  } | null>(null);
  const retainedState = attached?.key === retainedKey ? attached?.state : null;
  useLayoutEffect(() => {
    if (!backingTabId || !retainedKey) {
      setAttached(null);
      return;
    }
    const state = retainTasksState(serverId, workspaceId, backingTabId);
    setAttached(state ? { key: retainedKey, state } : null);
    // Component detach leaves the live backing tab's models available to the next shell.
  }, [serverId, workspaceId, backingTabId, retainedKey]);
  const focusedSessionAgent = useSessionStore((state) => {
    const session = state.sessions[serverId];
    const focusedId = session?.focusedAgentId;
    if (!focusedId) return null;
    const agent = session.agents.get(focusedId) ?? session.agentDetails.get(focusedId);
    return agent &&
      normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId)
      ? agent.id
      : null;
  });
  const liveWorkspaceAgentKey = useSessionStore((state) => {
    const session = state.sessions[serverId];
    if (!session) return "";
    const ids = [...session.agents.values(), ...session.agentDetails.values()]
      .filter(
        (agent) =>
          normalizeWorkspaceOpaqueId(agent.workspaceId) === normalizeWorkspaceOpaqueId(workspaceId),
      )
      .map((agent) => agent.id);
    return [...new Set(ids)].sort().join("\0");
  });
  const liveWorkspaceAgentIds = useMemo(
    () => new Set(liveWorkspaceAgentKey.split("\0").filter(Boolean)),
    [liveWorkspaceAgentKey],
  );
  const firstFocusedSessionAgent = useRef(focusedSessionAgent).current;
  const inheritedScope = useMemo<Pick<SwarmTaskSelection, "plannerName" | "agentName">>(() => {
    if (
      presentation !== "explorer" ||
      selection.plannerName !== undefined ||
      selection.agentName !== undefined
    )
      return {};
    const focusedTab = layout ? getFocusedOrdinaryTab(workspaceKey, layout) : undefined;
    if (
      focusedTab?.target.kind !== "swarm_tasks" ||
      (focusedTab.target.instance ?? "main") !== "main"
    )
      return {};
    const mainSelection = readSwarmTaskSelection(focusedTab.state);
    if (mainSelection.agentName !== undefined) return { agentName: mainSelection.agentName };
    if (mainSelection.plannerName !== undefined) return { plannerName: mainSelection.plannerName };
    return {};
  }, [layout, presentation, selection.agentName, selection.plannerName, workspaceKey]);
  const defaultAgentId = useMemo(() => {
    if (
      selection.plannerName !== undefined ||
      selection.agentName !== undefined ||
      inheritedScope.plannerName !== undefined ||
      inheritedScope.agentName !== undefined
    )
      return undefined;
    if (selection.defaultAgentId && liveWorkspaceAgentIds.has(selection.defaultAgentId)) {
      return selection.defaultAgentId;
    }
    const focusedTab = layout ? getFocusedOrdinaryTab(workspaceKey, layout) : undefined;
    if (
      focusedTab?.target.kind === "agent" &&
      liveWorkspaceAgentIds.has(focusedTab.target.agentId)
    ) {
      return focusedTab.target.agentId;
    }
    if (
      presentation === "explorer" &&
      focusedTab?.target.kind === "swarm_tasks" &&
      (focusedTab.target.instance ?? "main") === "main"
    ) {
      const mainSelection = readSwarmTaskSelection(focusedTab.state);
      if (mainSelection.defaultAgentId && liveWorkspaceAgentIds.has(mainSelection.defaultAgentId))
        return mainSelection.defaultAgentId;
    }
    return firstFocusedSessionAgent && liveWorkspaceAgentIds.has(firstFocusedSessionAgent)
      ? firstFocusedSessionAgent
      : undefined;
  }, [
    firstFocusedSessionAgent,
    inheritedScope,
    layout,
    liveWorkspaceAgentIds,
    presentation,
    selection.defaultAgentId,
    selection.agentName,
    selection.plannerName,
    workspaceKey,
  ]);
  const hasExplicitScope = selection.plannerName !== undefined || selection.agentName !== undefined;
  const isCompact = useIsCompactFormFactor();
  const isActive = useRetainedPanelActive();
  useEffect(() => {
    if (!tabId && isActive) ensureSwarmTasksTab(workspaceKey, "explorer");
  }, [isActive, tabId, workspaceKey]);
  useEffect(() => {
    const inheritedName = inheritedScope.plannerName ?? inheritedScope.agentName;
    if (presentation !== "explorer" || hasExplicitScope || inheritedName === undefined) return;
    const currentTabId = tabId ?? ensureSwarmTasksTab(workspaceKey, "explorer");
    if (!currentTabId) return;
    const currentTabLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const currentTab =
      currentTabLayout &&
      collectAllTabs(currentTabLayout.root).find((tab) => tab.tabId === currentTabId);
    const currentSelection = readSwarmTaskSelection(currentTab?.state);
    if (currentSelection.plannerName !== undefined || currentSelection.agentName !== undefined)
      return;
    setSwarmTaskSelection(workspaceKey, currentTabId, {
      ...inheritedScope,
      taskId: currentSelection.taskId,
      defaultAgentId: currentSelection.defaultAgentId,
    });
  }, [hasExplicitScope, inheritedScope, presentation, tabId, workspaceKey]);
  useEffect(() => {
    if (
      !defaultAgentId ||
      hasExplicitScope ||
      inheritedScope.plannerName !== undefined ||
      inheritedScope.agentName !== undefined ||
      selection.defaultAgentId === defaultAgentId
    )
      return;
    const currentTabId = tabId ?? ensureSwarmTasksTab(workspaceKey, "explorer");
    if (!currentTabId) return;
    const currentLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
    const currentTab =
      currentLayout && collectAllTabs(currentLayout.root).find((tab) => tab.tabId === currentTabId);
    const currentSelection = readSwarmTaskSelection(currentTab?.state);
    if (
      currentSelection.plannerName !== undefined ||
      currentSelection.agentName !== undefined ||
      currentSelection.defaultAgentId === defaultAgentId
    )
      return;
    setSwarmTaskSelection(workspaceKey, currentTabId, { ...currentSelection, defaultAgentId });
  }, [defaultAgentId, hasExplicitScope, inheritedScope, selection, tabId, workspaceKey]);
  const onOpenTask = useCallback(
    (taskId: string | undefined) => {
      const currentTabId = tabId ?? ensureSwarmTasksTab(workspaceKey, "explorer");
      if (!currentTabId) return;
      const currentTabLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      const current =
        currentTabLayout &&
        collectAllTabs(currentTabLayout.root).find((tab) => tab.tabId === currentTabId);
      setSwarmTaskSelection(workspaceKey, currentTabId, {
        ...readSwarmTaskSelection(current?.state),
        taskId,
      });
    },
    [tabId, workspaceKey],
  );
  const onScopeChange = useCallback(
    (scope: Pick<SwarmTaskSelection, "plannerName" | "agentName">) => {
      const currentTabId = tabId ?? ensureSwarmTasksTab(workspaceKey, "explorer");
      if (!currentTabId) return;
      const currentTabLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      const current =
        currentTabLayout &&
        collectAllTabs(currentTabLayout.root).find((tab) => tab.tabId === currentTabId);
      const currentSelection = readSwarmTaskSelection(current?.state);
      setSwarmTaskSelection(workspaceKey, currentTabId, {
        ...scope,
        taskId: currentSelection.taskId,
        defaultAgentId: currentSelection.defaultAgentId,
      });
    },
    [tabId, workspaceKey],
  );
  const onOpenReference = useCallback(
    (reference: SwarmTaskReference) => {
      if (!backingTabId) return;
      const currentLayout = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
      const current =
        currentLayout &&
        collectAllTabs(currentLayout.root).find((tab) => tab.tabId === backingTabId);
      if (!current || current.target.kind !== "swarm_tasks") return;
      openSwarmReference({
        serverId,
        workspaceId,
        reference,
        isCompact,
        host: presentation,
        selection: readSwarmTaskSelection(current.state),
      });
    },
    [backingTabId, isCompact, presentation, serverId, workspaceId, workspaceKey],
  );
  if (!retainedState || retainedState.isClosed()) return null;
  return (
    <SwarmTaskSurface
      serverId={serverId}
      workspaceId={workspaceId}
      {...selection}
      plannerName={inheritedScope.plannerName ?? selection.plannerName}
      agentName={inheritedScope.agentName ?? selection.agentName}
      retainedState={retainedState}
      defaultAgentId={defaultAgentId}
      isActive={isActive}
      keyboardInsetHandled={keyboardInsetHandled}
      presentation={presentation}
      onOpenTask={onOpenTask}
      onScopeChange={onScopeChange}
      onOpenReference={onOpenReference}
    />
  );
}

function SwarmTasksPanel() {
  const { serverId, workspaceId, tabId, host } = usePaneContext();
  return (
    <SwarmTasksContent
      serverId={serverId}
      workspaceId={workspaceId}
      tabId={tabId}
      presentation={host}
    />
  );
}

export const swarmTasksPanelRegistration = definePanel("swarm_tasks", {
  component: SwarmTasksPanel,
  presentation: {
    label: () => i18n.t("swarm.tasks.title"),
    subtitle: () => i18n.t("swarm.tasks.description"),
    tooltip: () => i18n.t("swarm.tasks.description"),
    icon: ThemedListTodo,
  },
});
