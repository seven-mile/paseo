/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import React, { useCallback, useMemo, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import type { InlinePathTarget } from "./parse";
import { AssistantFileLinkResolverProvider } from "./provider";
import type { DirectorySuggestionResult } from "./resolver";
import { useFileLink } from "./use-file-link";
import type { OpenFileDisposition } from "@/workspace/file-open";
import {
  PaneProvider,
  PaneFocusProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import { RetainedPanelActivity } from "@/components/retained-panel";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { SwarmCanonicalLinkProvider } from "@/swarm/canonical-links";
import { openSwarmReference } from "@/swarm/navigation";
import { openExternalUrl } from "@/utils/open-external-url";
import { i18n } from "@/i18n/i18next";

vi.stubGlobal("React", React);

let canonicalPlugin: {
  id: string;
  serverId: string;
  invoke: ReturnType<typeof vi.fn>;
  queryClient: QueryClient;
  lifetime: AbortController;
} | null = null;
let canonicalOnline = true;

vi.mock("@/plugins/registry", () => ({
  pluginRegistry: { getSnapshot: () => (canonicalPlugin ? [canonicalPlugin] : []) },
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getSnapshot: () => ({ connectionStatus: canonicalOnline ? "online" : "offline" }),
  }),
}));
vi.mock("@/swarm/navigation", () => ({ openSwarmReference: vi.fn() }));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

const SOURCE = {
  href: "http://dumm.md",
  text: "dumm.md",
  markup: "linkify",
};

function resolvedSuggestions(
  entries: DirectorySuggestionResult["entries"],
): DirectorySuggestionResult {
  return { entries, error: null };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });

  return { promise, resolve, reject };
}

interface OpenedFile {
  target: InlinePathTarget;
  disposition: OpenFileDisposition;
}

interface TestClient {
  getDirectorySuggestions: (input: {
    query: string;
    cwd: string;
    includeFiles: true;
    includeDirectories: false;
    matchMode: "suffix";
    limit: number;
  }) => Promise<DirectorySuggestionResult>;
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function createToast(): ToastApi {
  return {
    show: vi.fn<ToastApi["show"]>(),
    copied: vi.fn<ToastApi["copied"]>(),
    error: vi.fn<ToastApi["error"]>(),
  };
}

function createWrapper(input: { client: TestClient; openedFiles: OpenedFile[]; toast?: ToastApi }) {
  const queryClient = createQueryClient();
  return function Wrapper({ children }: { children: ReactNode }) {
    const openWorkspaceFile = useCallback(
      (target: InlinePathTarget, disposition: OpenFileDisposition) => {
        input.openedFiles.push({ target, disposition });
      },
      [],
    );

    return (
      <QueryClientProvider client={queryClient}>
        <AssistantFileLinkResolverProvider
          client={input.client}
          serverId="server-1"
          workspaceRoot="/Users/test/project"
          onOpenWorkspaceFile={openWorkspaceFile}
          toast={input.toast}
        >
          {children}
        </AssistantFileLinkResolverProvider>
      </QueryClientProvider>
    );
  };
}

const CANONICAL_PANE: PaneContextValue = {
  serverId: "server-1",
  workspaceId: "source",
  host: "explorer",
  tabId: "source-tab",
  target: { kind: "file", path: "report.md" },
  openTab() {},
  openPreferredTarget() {},
  closeCurrentTab() {},
  retargetCurrentTab() {},
  setCurrentTabState() {},
  openFileInWorkspace() {},
  openImportSheet() {},
};
const CANONICAL_BOARD = {
  version: 1,
  agents: [
    {
      paseoAgentId: "raw-agent",
      name: "worker",
      qualifiedName: "planner.worker",
      aliases: [],
      roleClass: "worker",
      reportsTo: null,
      workspaceId: "destination",
      retired: false,
    },
  ],
  tasks: [
    {
      id: "task-ID",
      title: "Task",
      brief: "",
      status: "development",
      managerName: "planner.worker",
      workerNames: [],
      createdBy: "human",
      updatedAt: "now",
    },
  ],
  activities: [],
};

function createCanonicalWrapper() {
  const tabId = useWorkspaceLayoutStore
    .getState()
    .openTab({ workspaceKey: "server-1:source", target: CANONICAL_PANE.target, intent: "new" });
  if (!tabId) throw new Error("Canonical source tab was not created");
  const controls = { pane: { ...CANONICAL_PANE, tabId }, active: true, focused: true };
  const openedFiles: OpenedFile[] = [];
  const toast = createToast();
  const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
  const FileWrapper = createWrapper({ client: { getDirectorySuggestions }, openedFiles, toast });
  function Wrapper({ children }: { children: ReactNode }) {
    const focused = controls.focused;
    const focus = useMemo(
      () => createPaneFocusContextValue({ isWorkspaceFocused: true, isPaneFocused: focused }),
      [focused],
    );
    return (
      <PaneProvider value={controls.pane}>
        <PaneFocusProvider value={focus}>
          <RetainedPanelActivity active={controls.active}>
            <ToastApiProvider api={toast}>
              <SwarmCanonicalLinkProvider>
                <FileWrapper>{children}</FileWrapper>
              </SwarmCanonicalLinkProvider>
            </ToastApiProvider>
          </RetainedPanelActivity>
        </PaneFocusProvider>
      </PaneProvider>
    );
  }
  return { Wrapper, controls, toast, openedFiles, getDirectorySuggestions };
}

describe("canonical assistant links", () => {
  beforeEach(() => {
    vi.mocked(openSwarmReference).mockClear();
    vi.mocked(openExternalUrl).mockClear();
    canonicalOnline = true;
    canonicalPlugin = {
      id: "paseo-swarm",
      serverId: "server-1",
      invoke: vi.fn(async () => CANONICAL_BOARD),
      queryClient: createQueryClient(),
      lifetime: new AbortController(),
    };
    const store = useSessionStore.getState();
    store.initializeSession("server-1", null);
    store.mergeWorkspaces(
      "server-1",
      ["source", "destination"].map((id) => ({
        id,
        projectId: "project",
        projectDisplayName: "Project",
        projectRootPath: "/repo",
        workspaceDirectory: "/repo",
        projectKind: "git" as const,
        workspaceKind: "local_checkout" as const,
        name: id,
        status: "done" as const,
        archivingAt: null,
        statusEnteredAt: null,
        diffStat: null,
        scripts: [],
      })),
    );
    store.setHasHydratedWorkspaces("server-1", true);
    useWorkspaceLayoutStore.setState({ layoutByWorkspace: {} });
  });

  it.each([
    [
      "paseo-swarm://agent/planner%2Eworker",
      {
        kind: "agent",
        paseoAgentId: "raw-agent",
        qualifiedName: "planner.worker",
        workspaceId: "destination",
      },
    ],
    ["paseo-swarm://task/task-ID", { kind: "task", taskId: "task-ID", workspaceId: "destination" }],
    [
      "PASEO-SWARM://file/destination/docs/a%20b.md",
      { kind: "file", workspaceId: "destination", path: "docs/a b.md" },
    ],
    ["paseo-swarm://workspace/destination", { kind: "workspace", workspaceId: "destination" }],
  ] as const)(
    "dispatches actual assistant press %s in its source pane",
    async (href, reference) => {
      const { Wrapper, openedFiles, getDirectorySuggestions } = createCanonicalWrapper();
      const { result } = renderHook(() => useFileLink({ href }), { wrapper: Wrapper });
      expect(canonicalPlugin?.invoke).not.toHaveBeenCalled();
      act(() => result.current.onPress());
      await waitFor(() =>
        expect(openSwarmReference).toHaveBeenCalledExactlyOnceWith({
          serverId: "server-1",
          workspaceId: "source",
          host: "explorer",
          isCompact: false,
          reference,
        }),
      );
      expect(openedFiles).toEqual([]);
      expect(getDirectorySuggestions).not.toHaveBeenCalled();
      expect(openExternalUrl).not.toHaveBeenCalled();
    },
  );

  it("uses the raw canonical href before file-looking label disambiguation", async () => {
    const { Wrapper, getDirectorySuggestions } = createCanonicalWrapper();
    const { result } = renderHook(
      () =>
        useFileLink({
          href: "paseo-swarm://agent/planner.worker",
          text: "report.md",
          markup: "linkify",
        }),
      { wrapper: Wrapper },
    );
    act(() => result.current.onPress());
    await waitFor(() => expect(openSwarmReference).toHaveBeenCalledOnce());
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it.each([
    "paseo-swarm://agent/missing",
    "paseo-swarm://file/destination/%2E%2E/secret",
    "paseo-swarm://file/destination/%ZZ",
  ])("consumes unavailable canonical target %s", async (href) => {
    const { Wrapper, toast } = createCanonicalWrapper();
    const { result } = renderHook(() => useFileLink({ href }), { wrapper: Wrapper });
    act(() => result.current.onPress());
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(i18n.t("swarm.tasks.referenceUnavailable"), {
        variant: "error",
      }),
    );
    expect(openSwarmReference).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it.each(["offline", "missing-plugin"])(
    "consumes %s without invoking the board",
    (availability) => {
      const invoke = canonicalPlugin?.invoke;
      if (availability === "offline") canonicalOnline = false;
      else canonicalPlugin = null;
      const { Wrapper, toast } = createCanonicalWrapper();
      const { result } = renderHook(
        () => useFileLink({ href: "paseo-swarm://agent/planner.worker" }),
        { wrapper: Wrapper },
      );
      act(() => result.current.onPress());
      expect(toast.show).toHaveBeenCalledWith(i18n.t("swarm.tasks.referenceUnavailable"), {
        variant: "error",
      });
      expect(invoke).not.toHaveBeenCalled();
      expect(openExternalUrl).not.toHaveBeenCalled();
    },
  );

  it("reports an unavailable board read without external navigation", async () => {
    canonicalPlugin?.invoke.mockRejectedValueOnce(new Error("Read failed"));
    const { Wrapper, toast } = createCanonicalWrapper();
    const { result } = renderHook(
      () => useFileLink({ href: "paseo-swarm://agent/planner.worker" }),
      { wrapper: Wrapper },
    );
    act(() => result.current.onPress());
    await waitFor(() =>
      expect(toast.show).toHaveBeenCalledWith(i18n.t("swarm.tasks.referenceUnavailable"), {
        variant: "error",
      }),
    );
    expect(openSwarmReference).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });

  it("allows a visible source pane press before pane focus changes", async () => {
    const { Wrapper, controls } = createCanonicalWrapper();
    controls.focused = false;
    const { result } = renderHook(
      () => useFileLink({ href: "paseo-swarm://agent/planner.worker" }),
      { wrapper: Wrapper },
    );
    act(() => result.current.onPress());
    await waitFor(() => expect(openSwarmReference).toHaveBeenCalledOnce());
  });

  it.each([
    "hidden",
    "focus",
    "scope",
    "unmount",
    "restored-visibility",
    "closed-tab",
    "retargeted-tab",
    "replaced-plugin",
  ])("drops a late canonical result after %s", async (change) => {
    const pending = createDeferred<unknown>();
    canonicalPlugin?.invoke.mockReturnValueOnce(pending.promise);
    const { Wrapper, controls, toast } = createCanonicalWrapper();
    const { result, rerender, unmount } = renderHook(
      () => useFileLink({ href: "paseo-swarm://agent/planner.worker" }),
      { wrapper: Wrapper },
    );
    act(() => result.current.onPress());
    act(() => {
      if (change === "unmount") unmount();
      else {
        if (change === "hidden") controls.active = false;
        if (change === "focus") controls.focused = false;
        if (change === "scope") controls.pane = { ...CANONICAL_PANE, tabId: "another-tab" };
        if (change === "closed-tab")
          useWorkspaceLayoutStore.getState().closeTab("server-1:source", controls.pane.tabId);
        if (change === "retargeted-tab")
          useWorkspaceLayoutStore.getState().replaceTab("server-1:source", controls.pane.tabId, {
            kind: "file",
            path: "another.md",
          });
        if (change === "replaced-plugin") canonicalPlugin = null;
        if (change === "restored-visibility") controls.active = false;
        rerender();
      }
    });
    if (change === "restored-visibility")
      act(() => {
        controls.active = true;
        rerender();
      });
    await act(async () => {
      pending.resolve(CANONICAL_BOARD);
      await pending.promise;
    });
    expect(openSwarmReference).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});

describe("useFileLink", () => {
  it("returns the same object across no-op parent rerenders", () => {
    const getDirectorySuggestions = vi.fn(async () => resolvedSuggestions([]));
    const queryClient = createQueryClient();
    const Provider = AssistantFileLinkResolverProvider as React.ComponentType<
      Omit<React.ComponentProps<typeof AssistantFileLinkResolverProvider>, "children"> & {
        children?: ReactNode;
      }
    >;

    function ChurningProviderWrapper({ children }: { children: ReactNode }) {
      return React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(
          Provider,
          {
            client: { getDirectorySuggestions },
            serverId: "server-1",
            workspaceRoot: "/Users/test/project",
            onOpenWorkspaceFile: () => {},
            toast: createToast(),
          },
          children,
        ),
      );
    }

    const { result, rerender } = renderHook(() => useFileLink({ ...SOURCE }), {
      wrapper: ChurningProviderWrapper,
    });
    const first = result.current;

    rerender();

    expect(result.current).toBe(first);
    expect(result.current.onHoverIn).toBe(first.onHoverIn);
    expect(result.current.onPress).toBe(first.onPress);
    expect(result.current.open).toBe(first.open);
  });

  it("does not cache unresolved lookups forever", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockResolvedValueOnce(resolvedSuggestions([]))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const toast = createToast();
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
        toast,
      }),
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(toast.show).toHaveBeenCalledWith("No file found for dumm.md", {
        variant: "error",
        testID: "assistant-file-link-not-found-toast",
      });
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toEqual([
        {
          target: {
            raw: "dumm.md",
            path: "/Users/test/project/docs/dumm.md",
            lineStart: undefined,
            lineEnd: undefined,
          },
          disposition: "preferred",
        },
      ]);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("click retries after hover prefetch fails", async () => {
    const getDirectorySuggestions = vi
      .fn()
      .mockRejectedValueOnce(new Error("daemon unavailable"))
      .mockResolvedValueOnce(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(2);
  });

  it("dedupes two links pointing at the same source", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(
      () => ({
        first: useFileLink(SOURCE),
        second: useFileLink(SOURCE),
      }),
      {
        wrapper: createWrapper({
          client: { getDirectorySuggestions },
          openedFiles,
        }),
      },
    );

    act(() => {
      result.current.first.onHoverIn();
      result.current.second.onHoverIn();
    });
    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));
    await waitFor(() => {
      expect(result.current.first.target?.path).toBe("/Users/test/project/docs/dumm.md");
      expect(result.current.second.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });
  });

  it("hover then click uses the prefetched result", async () => {
    const getDirectorySuggestions = vi.fn(async () =>
      resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]),
    );
    const openedFiles: OpenedFile[] = [];
    const { result } = renderHook(() => useFileLink(SOURCE), {
      wrapper: createWrapper({
        client: { getDirectorySuggestions },
        openedFiles,
      }),
    });

    act(() => {
      result.current.onHoverIn();
    });
    await waitFor(() => {
      expect(result.current.target?.path).toBe("/Users/test/project/docs/dumm.md");
    });

    act(() => {
      result.current.onPress();
    });
    await waitFor(() => {
      expect(openedFiles).toHaveLength(1);
    });
    expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
  });

  it("does not open a stale result after the workspace changes", async () => {
    const deferred = createDeferred<DirectorySuggestionResult>();
    const getDirectorySuggestions = vi.fn(() => deferred.promise);
    const openedFiles: OpenedFile[] = [];
    const queryClient = createQueryClient();

    function Wrapper({ children }: { children: ReactNode }) {
      const [workspaceRoot, setWorkspaceRoot] = useState("/Users/test/project");
      const client = useMemo(() => ({ getDirectorySuggestions }), []);
      const openWorkspaceFile = useCallback(
        (target: InlinePathTarget, disposition: OpenFileDisposition) => {
          openedFiles.push({ target, disposition });
        },
        [],
      );
      return (
        <QueryClientProvider client={queryClient}>
          <AssistantFileLinkResolverProvider
            client={client}
            serverId="server-1"
            workspaceRoot={workspaceRoot}
            onOpenWorkspaceFile={openWorkspaceFile}
          >
            <WorkspaceSwitchContext.Provider value={setWorkspaceRoot}>
              {children}
            </WorkspaceSwitchContext.Provider>
          </AssistantFileLinkResolverProvider>
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(
      () => ({
        link: useFileLink(SOURCE),
        setWorkspaceRoot: React.useContext(WorkspaceSwitchContext),
      }),
      { wrapper: Wrapper },
    );

    act(() => {
      result.current.link.onPress();
    });
    act(() => {
      result.current.setWorkspaceRoot("/Users/test/other");
    });
    deferred.resolve(resolvedSuggestions([{ path: "docs/dumm.md", kind: "file" }]));

    await waitFor(() => {
      expect(getDirectorySuggestions).toHaveBeenCalledTimes(1);
    });
    expect(openedFiles).toEqual([]);
  });
});

const WorkspaceSwitchContext = React.createContext<(workspaceRoot: string) => void>(() => {});
