import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

vi.mock("@/navigation/workspace-route-navigation", () => ({
  navigateToHostWorkspaceRoute: vi.fn(),
}));

import { navigateToHostWorkspaceRoute } from "@/navigation/workspace-route-navigation";
import { usePanelStore } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import {
  collectAllTabs,
  findPaneById,
  findPaneContainingTab,
  selectExplorerSidebarPaneId,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import {
  isExplorerSidebarOpen,
  openExplorerSidebarView,
  resolveExplorerSidebarPresentation,
  toggleExplorerSidebar,
} from "@/workspace-tabs/explorer-sidebar";
import { openSwarmTasks } from "@/swarm/navigation";

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

describe("planner board activation", () => {
  beforeEach(() => {
    vi.mocked(navigateToHostWorkspaceRoute).mockClear();
    useSessionStore.setState({ sessions: {} });
  });

  it("reactivates the same board with its raw hierarchy and selection while isolating other instances", () => {
    const store = useWorkspaceLayoutStore.getState();
    const main = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "swarm_tasks", instance: "main" },
      intent: "reveal",
    })!;
    const state = {
      plannerName: "team.原始-planner",
      agentName: "team.原始-planner.supervisor.worker",
      taskId: "task:原始/42",
      defaultAgentId: "agent:原始-id",
      hierarchy: ["planner", "supervisor", "worker"],
      opaque: { status: "raw-status", selection: "keep" },
    };
    store.setTabState(WORKSPACE_KEY, main, state);
    const explorerPane = store.showExplorerSidebar(WORKSPACE_KEY)!;
    const explorer = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "swarm_tasks", instance: "explorer" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: explorerPane },
    })!;
    const explorerState = { agentName: "other-supervisor", taskId: "other-task" };
    store.setTabState(WORKSPACE_KEY, explorer, explorerState);
    const foreignKeys = ["server-1:ws-other", "server-2:ws-main"];
    for (const workspaceKey of foreignKeys) {
      const tab = store.openTab({
        workspaceKey,
        target: { kind: "swarm_tasks", instance: "main" },
        intent: "reveal",
      })!;
      store.setTabState(workspaceKey, tab, { plannerName: workspaceKey, taskId: "foreign-task" });
    }
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "different-agent" },
      intent: "reveal",
    });
    const before = useWorkspaceLayoutStore.getState().layoutByWorkspace;
    const beforeTabs = collectAllTabs(before[WORKSPACE_KEY].root);

    openSwarmTasks({ serverId: "server-1", workspaceId: "ws-main", plannerName: "launch-planner" });

    const after = useWorkspaceLayoutStore.getState().layoutByWorkspace;
    const tabs = collectAllTabs(after[WORKSPACE_KEY].root);
    expect(tabs.map((tab) => tab.tabId)).toEqual(beforeTabs.map((tab) => tab.tabId));
    expect(tabs.find((tab) => tab.tabId === main)).toEqual(
      beforeTabs.find((tab) => tab.tabId === main),
    );
    expect(tabs.find((tab) => tab.tabId === main)?.state).toEqual(state);
    expect(findPaneById(after[WORKSPACE_KEY].root, "main")?.focusedTabId).toBe(main);
    expect(after[WORKSPACE_KEY].focusedPaneId).toBe("main");
    expect(tabs.find((tab) => tab.tabId === explorer)?.state).toEqual(explorerState);
    for (const workspaceKey of foreignKeys)
      expect(after[workspaceKey]).toEqual(before[workspaceKey]);
    expect(navigateToHostWorkspaceRoute).toHaveBeenCalledExactlyOnceWith(
      "/h/server-1/workspace/ws-main",
    );
  });

  it("reactivates a moved main board where the user placed it", () => {
    const store = useWorkspaceLayoutStore.getState();
    const tabId = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "swarm_tasks", instance: "main" },
      intent: "reveal",
    })!;
    const state = { agentName: "nested-supervisor", taskId: "selected-task" };
    store.setTabState(WORKSPACE_KEY, tabId, state);
    const sidePane = store.ensureSidePane(WORKSPACE_KEY)!;
    store.moveTabToPane(WORKSPACE_KEY, tabId, sidePane);
    store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "agent", agentId: "main-agent" },
      intent: "reveal",
      placement: { mode: "pane", paneId: "main" },
    });

    openSwarmTasks({ serverId: "server-1", workspaceId: "ws-main", plannerName: "planner" });

    const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneContainingTab(layout.root, tabId)?.id).toBe(sidePane);
    expect(findPaneById(layout.root, sidePane)?.focusedTabId).toBe(tabId);
    expect(layout.focusedPaneId).toBe(sidePane);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === tabId)?.state).toEqual(state);
    expect(
      collectAllTabs(layout.root).filter((tab) => tab.target.kind === "swarm_tasks"),
    ).toHaveLength(1);
  });

  it("creates a missing planner board beside an independent Explorer board and reopens it fresh", () => {
    const store = useWorkspaceLayoutStore.getState();
    const explorerPane = store.showExplorerSidebar(WORKSPACE_KEY)!;
    const explorer = store.openTab({
      workspaceKey: WORKSPACE_KEY,
      target: { kind: "swarm_tasks", instance: "explorer" },
      intent: "reveal",
      placement: { mode: "prefer", paneId: explorerPane },
    })!;
    const explorerState = { agentName: "supervisor", taskId: "explorer-task" };
    store.setTabState(WORKSPACE_KEY, explorer, explorerState);
    const input = { serverId: "server-1", workspaceId: "ws-main", plannerName: "planner" };

    openSwarmTasks(input);

    let layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(findPaneById(layout.root, "main")?.focusedTabId).toBe("swarm_tasks_main");
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === "swarm_tasks_main")?.state,
    ).toEqual({
      plannerName: "planner",
    });
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === explorer)?.state).toEqual(
      explorerState,
    );
    store.setTabState(WORKSPACE_KEY, "swarm_tasks_main", {
      agentName: "old-child",
      taskId: "old-task",
    });
    store.closeTab(WORKSPACE_KEY, "swarm_tasks_main");

    openSwarmTasks(input);

    layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
    expect(
      collectAllTabs(layout.root).find((tab) => tab.tabId === "swarm_tasks_main")?.state,
    ).toEqual({
      plannerName: "planner",
    });
    expect(
      collectAllTabs(layout.root).filter((tab) => tab.target.kind === "swarm_tasks"),
    ).toHaveLength(2);
    expect(collectAllTabs(layout.root).find((tab) => tab.tabId === explorer)?.state).toEqual(
      explorerState,
    );
  });

  it.each(["supervisor", "worker"])(
    "still navigates an existing Explorer board to the requested %s scope",
    (role) => {
      const store = useWorkspaceLayoutStore.getState();
      const explorerPane = store.showExplorerSidebar(WORKSPACE_KEY)!;
      const tabId = store.openTab({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "swarm_tasks", instance: "explorer" },
        intent: "reveal",
        placement: { mode: "prefer", paneId: explorerPane },
      })!;
      store.setTabState(WORKSPACE_KEY, tabId, { agentName: "old-scope", taskId: "old-task" });

      openSwarmTasks({
        serverId: "server-1",
        workspaceId: "ws-main",
        plannerName: "planner",
        agentName: `planner.${role}`,
        host: "explorer",
      });

      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
      expect(collectAllTabs(layout.root).find((tab) => tab.tabId === tabId)?.state).toEqual({
        plannerName: "planner",
        agentName: `planner.${role}`,
      });
      expect(findPaneById(layout.root, explorerPane)?.focusedTabId).toBe(tabId);
      expect(layout.focusedPaneId).toBe("main");
    },
  );

  it.each([
    {
      selection: { agentName: "new-agent", taskId: undefined },
      expected: { plannerName: "planner", agentName: "new-agent" },
    },
    {
      selection: { agentName: undefined, taskId: "explicit-target" },
      expected: { plannerName: "planner", taskId: "explicit-target" },
    },
  ])(
    "keeps explicit main scope or Task navigation authoritative: %j",
    ({ selection, expected }) => {
      const store = useWorkspaceLayoutStore.getState();
      const tabId = store.openTab({
        workspaceKey: WORKSPACE_KEY,
        target: { kind: "swarm_tasks", instance: "main" },
        intent: "reveal",
      })!;
      store.setTabState(WORKSPACE_KEY, tabId, { agentName: "old-child", taskId: "old-task" });

      openSwarmTasks({
        serverId: "server-1",
        workspaceId: "ws-main",
        plannerName: "planner",
        ...selection,
      });

      const layout = useWorkspaceLayoutStore.getState().layoutByWorkspace[WORKSPACE_KEY];
      expect(collectAllTabs(layout.root).find((tab) => tab.tabId === tabId)?.state).toEqual(
        expected,
      );
      expect(findPaneById(layout.root, "main")?.focusedTabId).toBe(tabId);
    },
  );
});
