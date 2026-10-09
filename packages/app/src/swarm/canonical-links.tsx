import { createContext, useContext, useLayoutEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePaneContext, usePaneFocus, type PaneContextValue } from "@/panels/pane-context";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-api-context";
import { useStableEvent } from "@/hooks/use-stable-event";
import { pluginRegistry } from "@/plugins/registry";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneContainingTab,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { openSwarmReference } from "./navigation";
import { resolveSwarmTaskReference, swarmTaskBoardSchema } from "./task-model";

const CanonicalLinkContext = createContext<((uri: string) => boolean) | null>(null);

export function SwarmCanonicalLinkProvider({ children }: { children: ReactNode }) {
  const { serverId, workspaceId, tabId, host, target } = usePaneContext();
  const { isWorkspaceFocused, isPaneFocused, focusPane } = usePaneFocus();
  const active = useRetainedPanelActive() && isWorkspaceFocused;
  const isCompact = useIsCompactFormFactor();
  const toast = useToast();
  const { t } = useTranslation();
  const generation = useRef(0);
  const mounted = useRef(false);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useLayoutEffect(() => {
    generation.current += 1;
  }, [serverId, workspaceId, tabId, host, target]);
  useLayoutEffect(() => {
    if (!active || !isPaneFocused) generation.current += 1;
  }, [active, isPaneFocused]);

  const canDeliver = useStableEvent(
    (
      capturedGeneration: number,
      source: Pick<PaneContextValue, "serverId" | "workspaceId" | "tabId" | "host" | "target">,
    ) => {
      if (!mounted.current || !active || generation.current !== capturedGeneration) return false;
      if (
        serverId !== source.serverId ||
        workspaceId !== source.workspaceId ||
        tabId !== source.tabId ||
        host !== source.host ||
        !workspaceTabTargetsEqual(target, source.target)
      )
        return false;
      const layout =
        useWorkspaceLayoutStore.getState().layoutByWorkspace[`${serverId}:${workspaceId}`];
      const pane = layout && findPaneContainingTab(layout.root, tabId);
      const tab =
        layout && collectAllTabs(layout.root).find((candidate) => candidate.tabId === tabId);
      return Boolean(
        pane &&
        !pane.hidden &&
        pane.focusedTabId === tabId &&
        tab &&
        workspaceTabTargetsEqual(tab.target, source.target),
      );
    },
  );
  const unavailable = useStableEvent(() => {
    toast.show(t("swarm.tasks.referenceUnavailable"), { variant: "error" });
  });
  const openLink = useStableEvent((uri: string) => {
    if (!/^paseo-swarm:\/\//i.test(uri)) return true;
    if (!mounted.current || !active) return false;
    focusPane();
    const source = { serverId, workspaceId, tabId, host, target };
    const capturedGeneration = generation.current;
    if (!canDeliver(capturedGeneration, source)) return false;
    const plugin = pluginRegistry
      .getSnapshot()
      .find((candidate) => candidate.serverId === serverId && candidate.id === "paseo-swarm");
    const online = () => getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus === "online";
    if (!plugin || plugin.lifetime.signal.aborted || !online()) {
      unavailable();
      return false;
    }
    const current = () =>
      canDeliver(capturedGeneration, source) &&
      !plugin.lifetime.signal.aborted &&
      pluginRegistry.getSnapshot().includes(plugin);

    const resolve = async () => {
      try {
        const board = await plugin.queryClient.fetchQuery({
          queryKey: ["swarm", "canonical-link-board", serverId],
          queryFn: async () =>
            swarmTaskBoardSchema.parse(await plugin.invoke("swarm.board.read", {})),
          staleTime: 0,
          retry: false,
        });
        if (!current()) return;
        if (!online()) {
          unavailable();
          return;
        }
        const session = useSessionStore.getState().sessions[serverId];
        const reference = session?.hasHydratedWorkspaces
          ? resolveSwarmTaskReference(uri, board, [...session.workspaces.keys()])
          : null;
        if (!reference) {
          unavailable();
          return;
        }
        openSwarmReference({ serverId, workspaceId, reference, isCompact, host });
      } catch {
        if (current()) unavailable();
      }
    };
    void resolve();
    return false;
  });

  return <CanonicalLinkContext.Provider value={openLink}>{children}</CanonicalLinkContext.Provider>;
}

export function useSwarmCanonicalLinkPress(): ((uri: string) => boolean) | null {
  return useContext(CanonicalLinkContext);
}

export function useMarkdownLinkPress(onLinkPress?: (uri: string) => boolean) {
  const canonicalLinkPress = useSwarmCanonicalLinkPress();
  return useStableEvent((uri: string) => {
    if (onLinkPress?.(uri) === false) return false;
    return canonicalLinkPress?.(uri) ?? true;
  });
}
