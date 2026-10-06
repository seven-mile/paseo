import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

import { usePanelStore } from "@/stores/panel-store";
import {
  collectAllTabs,
  findPaneById,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarView,
  resolveExplorerSidebarPresentation,
  toggleExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";

const WORKSPACE_KEY = "server-1:ws-main";
const CHECKOUT = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };

beforeEach(() => {
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    explorerSidebarPaneIdByWorkspace: {},
    sidePaneIdByWorkspace: {},
    splitSizesByWorkspace: {},
  });
  usePanelStore.setState({
    mobilePanel: { target: "agent", revision: 0 },
    explorerTab: "files",
    explorerTabByCheckout: {},
  });
});

describe("Explorer sidebar", () => {
  it("selects the Explorer shell from layout and split capabilities", () => {
    expect(resolveExplorerSidebarPresentation({ isCompact: true })).toBe("overlay");
    expect(
      resolveExplorerSidebarPresentation({ isCompact: false, supportsPaneSplits: false }),
    ).toBe("dock");
    expect(resolveExplorerSidebarPresentation({ isCompact: false, supportsPaneSplits: true })).toBe(
      "pane",
    );
  });

  it("uses the compact explorer without creating a desktop pane", () => {
    openExplorerSidebarView({
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      view: "changes",
    });

    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });

  it("creates a dedicated desktop Explorer containing only its requested tree", () => {
    openExplorerSidebarView({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      view: "files",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const paneId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    expect(paneId).not.toBeNull();
    expect(layout && collectAllTabs(layout.root).map((tab) => tab.target.kind)).toContain("files");
  });

  it("opens Tasks beside Files and Changes while preserving the main agent", () => {
    const agentTabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "agent-1" },
      intent: "reveal",
    });
    openExplorerSidebarView({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      view: "tasks",
    });
    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    const explorerId = selectExplorerSidebarPaneId(state, WORKSPACE_KEY);
    const explorer = findPaneById(layout.root, explorerId);
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(agentTabId);
    expect(layout.focusedPaneId).toBe("main");
    expect(
      collectAllTabs(layout.root)
        .filter((tab) => explorer?.tabIds.includes(tab.tabId))
        .map((tab) => tab.target.kind),
    ).toEqual(["files", "changes_tree", "swarm_tasks"]);
    expect(explorer?.focusedTabId).toBe("swarm_tasks_explorer");
  });

  it("keeps main and Explorer Tasks simultaneously selected", () => {
    const mainTabId = useWorkspaceLayoutStore.getState().openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "swarm_tasks", instance: "main" },
      intent: "reveal",
    });
    openExplorerSidebarView({
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
      view: "tasks",
    });

    const state = useWorkspaceLayoutStore.getState();
    const layout = state.layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(mainTabId);
    expect(
      findPaneById(layout.root, selectExplorerSidebarPaneId(state, WORKSPACE_KEY))?.focusedTabId,
    ).toBe("swarm_tasks_explorer");
    expect(
      collectAllTabs(layout.root).filter((tab) => tab.target.kind === "swarm_tasks"),
    ).toHaveLength(2);
    expect(layout.focusedPaneId).toBe("main");
  });

  it("selects Tasks in the native Explorer dock and keeps that view when toggled", () => {
    const input = {
      isCompact: false,
      supportsPaneSplits: false,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
    };
    openExplorerSidebarView({ ...input, view: "tasks" });
    toggleExplorerSidebar(input);
    toggleExplorerSidebar(input);
    expect(usePanelStore.getState().mobilePanel.target).toBe("file-explorer");
    expect(usePanelStore.getState().explorerTab).toBe("tasks");
    expect(useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY]).toBeUndefined();
  });

  it("toggles the desktop Explorer independently of ordinary panes", () => {
    const input = {
      isCompact: false,
      supportsPaneSplits: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
    };
    openExplorerSidebarView({ ...input, view: "files" });
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(false);
    toggleExplorerSidebar(input);
    expect(isExplorerSidebarOpen(input)).toBe(true);
    const openedState = useWorkspaceLayoutStore.getState();
    const openedLayout = openedState.layoutByWorkspace[WORKSPACE_KEY];
    const explorerPaneId = selectExplorerSidebarPaneId(openedState, WORKSPACE_KEY);
    const explorerPane =
      openedLayout && explorerPaneId ? findPaneById(openedLayout.root, explorerPaneId) : null;
    const activeExplorerTarget =
      openedLayout && explorerPane
        ? collectAllTabs(openedLayout.root).find((tab) => tab.tabId === explorerPane.focusedTabId)
            ?.target.kind
        : null;
    expect(activeExplorerTarget).toBe("files");
  });

  it("toggles the compact Explorer without changing its selected view", () => {
    usePanelStore.getState().setExplorerTabForCheckout({ ...CHECKOUT, tab: "files" });
    const input = {
      isCompact: true,
      workspaceKey: WORKSPACE_KEY,
      checkout: CHECKOUT,
    };

    toggleExplorerSidebar(input);

    expect(isExplorerSidebarOpen(input)).toBe(true);
    expect(usePanelStore.getState().explorerTab).toBe("files");
  });
});
