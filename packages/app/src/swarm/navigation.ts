import { z } from "zod";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllPanes,
  collectAllTabs,
  findPaneById,
  DEFAULT_PANE_ID,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  normalizeWorkspaceOpaqueId,
  resolveWorkspaceMapKeyByIdentity,
} from "@/utils/workspace-identity";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  openExplorerSidebarView,
  usesCompactExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";
import type { ExplorerCheckoutContext } from "@/stores/explorer-checkout-context";
import type { WorkspaceTab } from "@/workspace-tabs/model";
import type { WorkspaceLayout } from "@/stores/workspace-layout-actions";
import type { SwarmTaskReference } from "./task-model";

export interface SwarmTaskSelection {
  plannerName?: string;
  agentName?: string;
  taskId?: string;
  defaultAgentId?: string;
}

const selectionSchema = z.object({
  plannerName: z.string().optional(),
  agentName: z.string().optional(),
  taskId: z.string().optional(),
  defaultAgentId: z.string().optional(),
});

export function readSwarmTaskSelection(state: unknown): SwarmTaskSelection {
  const parsed = selectionSchema.safeParse(state);
  return parsed.success ? parsed.data : {};
}

export function setSwarmTaskSelection(
  workspaceKey: string,
  tabId: string,
  selection: SwarmTaskSelection,
): void {
  const state: Record<string, string> = {};
  if (selection.plannerName !== undefined) state.plannerName = selection.plannerName;
  if (selection.agentName !== undefined) state.agentName = selection.agentName;
  if (selection.taskId) state.taskId = selection.taskId;
  if (selection.defaultAgentId) state.defaultAgentId = selection.defaultAgentId;
  useWorkspaceLayoutStore.getState().setTabState(workspaceKey, tabId, state);
}

/** Returns the tab that owns current workspace focus, falling back to the ordinary pane only when Explorer is focused. */
export function getFocusedOrdinaryTab(
  workspaceKey: string,
  layout: WorkspaceLayout,
): WorkspaceTab | undefined {
  const store = useWorkspaceLayoutStore.getState();
  const focusedPane = findPaneById(layout.root, layout.focusedPaneId);
  const explorerPaneId = store.explorerSidebarPaneIdByWorkspace[workspaceKey];
  const pane =
    focusedPane && (focusedPane.id === explorerPaneId || focusedPane.id === "explorer")
      ? findPaneById(layout.root, DEFAULT_PANE_ID)
      : focusedPane;
  if (!pane?.focusedTabId) return undefined;
  return collectAllTabs(layout.root).find((tab) => tab.tabId === pane.focusedTabId);
}

function openCrossWorkspaceTaskReference(input: {
  serverId: string;
  workspaceId: string;
  taskId: string;
}): void {
  const workspaces = useSessionStore.getState().sessions[input.serverId]?.workspaces;
  const workspaceId =
    resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: input.workspaceId }) ??
    input.workspaceId;
  const workspaceKey = `${input.serverId}:${workspaceId}`;
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId,
    target: { kind: "swarm_tasks", instance: "main" },
  });
  const store = useWorkspaceLayoutStore.getState();
  const layout = store.layoutByWorkspace[workspaceKey];
  const paneId = layout
    ? collectAllPanes(layout.root).find((pane) => pane.id === DEFAULT_PANE_ID)?.id
    : undefined;
  const tabId = store.openTab({
    workspaceKey,
    target: { kind: "swarm_tasks", instance: "main" },
    intent: "new",
    state: { agentName: "", taskId: input.taskId },
    placement: paneId ? { mode: "prefer", paneId } : undefined,
  });
  if (tabId) store.focusTab(workspaceKey, tabId);
}

function findSessionAgent(
  session: ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined,
  agentId: string | undefined,
) {
  if (!session || !agentId) return undefined;
  return session.agents.get(agentId) ?? session.agentDetails.get(agentId);
}

function focusedSwarmTaskAgentId(input: {
  plannerName?: string;
  agentName?: string;
  workspaceId: string;
  session: ReturnType<typeof useSessionStore.getState>["sessions"][string] | undefined;
  focusedTab?: WorkspaceTab;
}): string | undefined {
  if (input.plannerName !== undefined || input.agentName !== undefined) return undefined;
  const focusedTabAgent =
    input.focusedTab?.target.kind === "agent"
      ? findSessionAgent(input.session, input.focusedTab.target.agentId)
      : undefined;
  if (
    input.focusedTab?.target.kind === "agent" &&
    focusedTabAgent &&
    normalizeWorkspaceOpaqueId(focusedTabAgent.workspaceId) ===
      normalizeWorkspaceOpaqueId(input.workspaceId)
  ) {
    return input.focusedTab.target.agentId;
  }
  const focusedSessionAgent = findSessionAgent(
    input.session,
    input.session?.focusedAgentId ?? undefined,
  );
  return focusedSessionAgent &&
    normalizeWorkspaceOpaqueId(focusedSessionAgent.workspaceId) ===
      normalizeWorkspaceOpaqueId(input.workspaceId)
    ? focusedSessionAgent.id
    : undefined;
}

function navigateToSwarmTasks(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string;
  workspace?: { workspaceDirectory?: string; projectKind?: string };
  host: "main" | "explorer";
  isCompact: boolean;
}): void {
  if (input.host === "explorer") {
    const checkout: ExplorerCheckoutContext | null = input.workspace?.workspaceDirectory
      ? {
          serverId: input.serverId,
          cwd: input.workspace.workspaceDirectory,
          isGit: input.workspace.projectKind === "git",
        }
      : null;
    const explorer = {
      isCompact: input.isCompact,
      workspaceKey: input.workspaceKey,
      checkout,
    };
    if (usesCompactExplorerSidebar(explorer)) {
      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[input.workspaceKey];
      const focusedId = layout && findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId;
      const focused = layout && collectAllTabs(layout.root).find((tab) => tab.tabId === focusedId);
      navigateToWorkspace({
        serverId: input.serverId,
        workspaceId: input.workspaceId,
        target: focused?.target.kind !== "new_tab" ? focused?.target : undefined,
      });
      openExplorerSidebarView({ ...explorer, view: "tasks" });
      return;
    }
    navigateToWorkspace({
      serverId: input.serverId,
      workspaceId: input.workspaceId,
      target: { kind: "swarm_tasks", instance: input.host },
    });
    return;
  }
  usePanelStore.getState().showMobileAgent();
  navigateToWorkspace({
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    target: { kind: "swarm_tasks", instance: input.host },
  });
}

/** Each logical instance retains its own state even when the user moves it to another pane. */
export function ensureSwarmTasksTab(
  workspaceKey: string,
  instance: "main" | "explorer",
): string | null {
  const store = useWorkspaceLayoutStore.getState();
  const target = { kind: "swarm_tasks" as const, instance };
  const layout = store.layoutByWorkspace[workspaceKey];
  const existing =
    layout &&
    collectAllTabs(layout.root).find(
      (tab) => tab.target.kind === "swarm_tasks" && (tab.target.instance ?? "main") === instance,
    );
  if (existing) return existing.tabId;
  let paneId: string | undefined;
  if (instance === "explorer") paneId = store.showExplorerSidebar(workspaceKey) ?? undefined;
  else if (layout)
    paneId = collectAllPanes(layout.root).find((pane) => pane.id === DEFAULT_PANE_ID)?.id;
  return store.openTab({
    workspaceKey,
    target,
    intent: "background",
    placement: paneId ? { mode: "prefer", paneId } : undefined,
  });
}

export function openSwarmTasks(
  input: SwarmTaskSelection & {
    serverId: string;
    workspaceId: string;
    host?: "main" | "explorer";
    isCompact?: boolean;
  },
): void {
  const { serverId, host = "main", isCompact = false } = input;
  const workspaces = useSessionStore.getState().sessions[serverId]?.workspaces;
  const workspaceId =
    resolveWorkspaceMapKeyByIdentity({ workspaces, workspaceId: input.workspaceId }) ??
    input.workspaceId;
  const workspace = workspaces?.get(workspaceId);
  const workspaceKey = `${serverId}:${workspaceId}`;
  const layoutBeforeOpen = useWorkspaceLayoutStore.getState().layoutByWorkspace[workspaceKey];
  const mainFocusedTab = layoutBeforeOpen
    ? getFocusedOrdinaryTab(workspaceKey, layoutBeforeOpen)
    : undefined;
  const session = useSessionStore.getState().sessions[serverId];
  const defaultAgentId = focusedSwarmTaskAgentId({
    plannerName: input.plannerName,
    agentName: input.agentName,
    workspaceId,
    session,
    focusedTab: mainFocusedTab,
  });
  const tabId = ensureSwarmTasksTab(workspaceKey, host);
  if (!tabId) return;
  const existed =
    layoutBeforeOpen && collectAllTabs(layoutBeforeOpen.root).some((tab) => tab.tabId === tabId);
  const activatePlannerBoard =
    existed &&
    host === "main" &&
    input.plannerName !== undefined &&
    input.agentName === undefined &&
    input.taskId === undefined;
  if (!activatePlannerBoard) {
    setSwarmTaskSelection(workspaceKey, tabId, {
      plannerName: input.plannerName,
      agentName: input.agentName,
      taskId: input.taskId,
      defaultAgentId,
    });
  }
  navigateToSwarmTasks({
    serverId,
    workspaceId,
    workspaceKey,
    workspace,
    host,
    isCompact,
  });
}

/** Agent links resolve the live workspace; file links open their exact preview target. */
export function openSwarmReference(input: {
  serverId: string;
  workspaceId: string;
  reference: SwarmTaskReference;
  isCompact?: boolean;
  host?: "main" | "explorer";
  selection?: Pick<SwarmTaskSelection, "plannerName" | "agentName">;
}): void {
  const { serverId, reference } = input;
  if (input.isCompact) usePanelStore.getState().showMobileAgent();
  switch (reference.kind) {
    case "agent":
      navigateToAgent({
        serverId,
        agentId: reference.paseoAgentId,
      });
      break;
    case "workspace":
      navigateToWorkspace({ serverId, workspaceId: reference.workspaceId });
      break;
    case "file":
      navigateToWorkspace({
        serverId,
        workspaceId: reference.workspaceId,
        target: { kind: "file", path: reference.path },
      });
      break;
    case "task":
      {
        const destinationWorkspaceId =
          "workspaceId" in reference && typeof reference.workspaceId === "string"
            ? reference.workspaceId
            : null;
        if (destinationWorkspaceId) {
          openCrossWorkspaceTaskReference({
            serverId,
            workspaceId: destinationWorkspaceId,
            taskId: reference.taskId,
          });
        } else {
          openSwarmTasks({
            serverId,
            workspaceId: input.workspaceId,
            host: input.host,
            ...input.selection,
            taskId: reference.taskId,
          });
        }
      }
      break;
  }
}
