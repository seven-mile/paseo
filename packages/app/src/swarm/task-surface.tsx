import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
} from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import { ArrowLeft, MoreHorizontal } from "lucide-react-native";
import { i18n } from "@/i18n/i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import type { QueryClient, UseQueryResult } from "@tanstack/react-query";
import { RetainedPanel, useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isNative } from "@/constants/platform";
import { useContainerWidthBelow } from "@/hooks/use-container-width";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/ui/scrollable-code-surface";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { StatusBadge } from "@/components/ui/status-badge";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import {
  SETTINGS_DESKTOP_SIDEBAR_WIDTH,
  SETTINGS_DESKTOP_SPLIT_MIN_WIDTH,
  useIsCompactFormFactor,
} from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import {
  useHasHydratedWorkspaces,
  useWorkspaceDirectory,
  useWorkspaceFields,
  useWorkspaceStructure,
} from "@/stores/session-store-hooks";
import { filterSwarmArtifacts } from "./artifact-model";
import { DeliveredArtifacts, SwarmArtifactList, useSwarmArtifacts } from "./artifact-views";
import { SwarmInlineLink } from "./inline-link";
import { resolveArtifactCopyLink } from "./artifact-links";
import { useSwarmCanonicalLinkPress } from "./canonical-links";
import { SwarmCcLine } from "./cc-line";
import { TaskCloseControl } from "./task-close";
import { useSwarmRpc } from "./rpc";
import { PERSON_SENDER } from "./system-envelope";
import {
  SWARM_POLL_MS,
  SWARM_TASK_ACTIVITY_MAX,
  SWARM_TASK_ACTIVITY_PAGE,
  selectSwarmValue,
  swarmConditionalQuery,
} from "./sync";
import {
  activityChoice,
  defaultSwarmCc,
  defaultSwarmTaskScope,
  findSwarmTaskAgent,
  filterSwarmTasks,
  isSwarmActivitySubmitShortcut,
  notesNotInBrief,
  openSwarmTaskSurfaceState,
  partitionSwarmTasks,
  swarmAttentionTotal,
  responseProfiles,
  resolveSwarmTaskReference,
  scopedSwarmTasks,
  swarmTaskBoardSchema,
  swarmTaskDetailSchema,
  swarmHumanActivityReceiptSchema,
  swarmTaskScopeOptions,
  swarmTaskColumns,
  swarmArtifactHref,
  swarmAudience,
  swarmTaskResult,
  unansweredChoices,
  type SwarmActivity,
  type SwarmTask,
  type SwarmTaskAgent,
  type SwarmTaskBoard,
  type SwarmTaskDetail,
  type SwarmTaskReference,
  type SwarmTaskSurfaceState,
} from "./task-model";

export interface SwarmTaskSurfaceProps {
  serverId: string;
  workspaceId: string;
  retainedState?: SwarmTaskSurfaceState;
  plannerName?: string;
  agentName?: string;
  taskId?: string;
  isActive?: boolean;
  keyboardInsetHandled?: boolean;
  presentation?: "main" | "explorer";
  defaultAgentId?: string;
  onOpenTask?: (taskId: string | undefined) => void;
  onScopeChange?: (scope: { plannerName?: string; agentName?: string }) => void;
  onOpenReference?: (reference: SwarmTaskReference) => void;
}

const FLEX_STYLE = { flex: 1 };
const NO_CC: string[] = [];
const NO_AGENTS: SwarmTaskAgent[] = [];
// Swarm writes these itself when a Task operation changes it; they read as one line of history.
const CHANGE_KIND = "change";
const EMPTY_ACTIVITIES: readonly SwarmActivity[] = [];
const TaskMarkdown = memo(MarkdownRenderer);
// What authored Markdown needs to link the paths its author wrote: the host and the seats.
const TaskAuthorsContext = createContext<{
  serverId: string;
  agents: readonly SwarmTaskAgent[];
} | null>(null);
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedMoreHorizontal = withUnistyles(MoreHorizontal);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

function TaskSelect({
  label,
  value,
  options,
  onSelect,
  disabled = false,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onSelect: (value: string) => void;
  disabled?: boolean;
}) {
  const compact = useIsCompactFormFactor();
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownTrigger size={compact ? "md" : "sm"} accessibilityLabel={label} disabled={disabled}>
        {options.find((option) => option.value === value)?.label ?? value}
      </DropdownTrigger>
      <DropdownMenuContent sheetTitle={label}>
        {options.map((option) => (
          <TaskSelectOption
            key={option.value}
            selected={option.value === value}
            value={option.value}
            label={option.label}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TaskSelectOption({
  value,
  label,
  selected,
  onSelect,
  closeOnSelect = true,
}: {
  value: string;
  label: string;
  selected: boolean;
  onSelect: (value: string) => void;
  closeOnSelect?: boolean;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select} closeOnSelect={closeOnSelect}>
      {label}
    </DropdownMenuItem>
  );
}

function TaskStatusFilter({
  statuses,
  options,
  onToggle,
}: {
  statuses: readonly string[];
  options: Array<{ value: string; label: string }>;
  onToggle: (value: string) => void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  let label = t("swarm.tasks.allStatuses");
  if (statuses.length === 1) label = statuses[0];
  else if (statuses.length > 1)
    label = t("swarm.tasks.selectedStatuses", { count: statuses.length });
  return (
    <DropdownMenu compactMode="sheet">
      <DropdownTrigger
        size={compact ? "md" : "sm"}
        accessibilityLabel={`${t("swarm.tasks.status")}: ${statuses.length ? statuses.join(", ") : label}`}
        testID="swarm-task-status-filter"
      >
        {label}
      </DropdownTrigger>
      <DropdownMenuContent sheetTitle={t("swarm.tasks.status")}>
        {options.map((option) => (
          <TaskSelectOption
            key={option.value}
            selected={option.value ? statuses.includes(option.value) : statuses.length === 0}
            value={option.value}
            label={option.label}
            onSelect={onToggle}
            closeOnSelect={false}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function SwarmTaskSurface(props: SwarmTaskSurfaceProps) {
  // Scope/reference navigation keeps per-task drafts within this host/workspace lifetime.
  return <TaskSurface key={`${props.serverId}:${props.workspaceId}`} {...props} />;
}

function TaskSurface({
  serverId,
  workspaceId,
  isActive = true,
  keyboardInsetHandled = false,
  retainedState: providedState,
  ...selection
}: SwarmTaskSurfaceProps) {
  useTranslation();
  const [localState] = useState(openSwarmTaskSurfaceState);
  const retainedState = providedState ?? localState;
  useEffect(() => () => localState.close(), [localState]);
  const { plugin, invoke } = useSwarmRpc(serverId);
  const connection = useHostRuntimeConnectionStatus(serverId);
  const retainedActive = useRetainedPanelActive();
  const active = isActive && retainedActive;
  const compact = useIsCompactFormFactor();
  const hosts = useMemo(() => [serverId], [serverId]);
  const structure = useWorkspaceStructure(hosts);
  const projectId = useWorkspaceFields(serverId, workspaceId, (workspace) => workspace.projectId);
  const hydrated = useHasHydratedWorkspaces(serverId);
  const project = structure.projects.find((candidate) =>
    candidate.hosts.some((host) => host.serverId === serverId && host.projectId === projectId),
  );
  const projectWorkspaceIds = useMemo(
    () => (project ? workspaceIdsForHost(project.workspaceKeys, serverId) : []),
    [project, serverId],
  );
  const knownWorkspaceIds = useMemo(
    () =>
      workspaceIdsForHost(
        structure.projects.flatMap((candidate) => candidate.workspaceKeys),
        serverId,
      ),
    [structure, serverId],
  );
  const online = connection === "online";
  const boardKey = useMemo(() => ["swarm", "tasks", serverId, projectId], [serverId, projectId]);
  const query = useFetchQuery(
    {
      queryKey: boardKey,
      queryFn: swarmConditionalQuery({
        queryClient: plugin?.queryClient,
        queryKey: boardKey,
        schema: swarmTaskBoardSchema,
        read: (etag) =>
          invoke("swarm.tasks.read", {
            projectId: projectId ?? undefined,
            // Older hosts ignore the view and list every Task, which the lanes still sort.
            view: "current",
            ...(etag ? { etag } : {}),
          }),
      }),
      select: selectSwarmValue<SwarmTaskBoard>,
      enabled: Boolean(plugin) && Boolean(projectId) && hydrated && online && active,
      dataShape: "value",
      staleTimeMs: SWARM_POLL_MS - 500,
      refetchInterval: active ? SWARM_POLL_MS : false,
    },
    plugin?.queryClient,
  );
  const { refetch } = query;
  const refresh = useCallback(() => {
    if (online && active) void refetch();
  }, [refetch, online, active]);
  const { style: keyboardStyle } = useKeyboardShiftStyle({
    mode: "padding",
    enabled: compact && isNative && active && !keyboardInsetHandled,
  });
  const insetStyle = useMemo(() => [FLEX_STYLE, keyboardStyle], [keyboardStyle]);
  const unavailable = taskAvailability({
    online,
    installed: Boolean(plugin),
    hydrated,
    projectId,
    hasProject: Boolean(project),
  });
  const authors = useTaskAuthors(serverId, query.data);
  return (
    <TaskAuthorsContext.Provider value={authors}>
      <View style={styles.root} testID="swarm-task-surface">
        <Animated.View style={insetStyle}>
          <TaskToolbar
            label={project?.projectName}
            compact={compact}
            refreshing={query.isFetching}
            disabled={!plugin || !online || !active}
            onRefresh={refresh}
          />
          <TaskLoadContent
            retainedState={retainedState}
            query={query}
            unavailable={unavailable}
            hydrated={hydrated}
            connecting={connection === "connecting" || connection === "idle"}
            online={online}
            active={active}
            workspaceId={workspaceId}
            projectWorkspaceIds={projectWorkspaceIds}
            knownWorkspaceIds={knownWorkspaceIds}
            compact={compact}
            invoke={invoke}
            queryClient={plugin?.queryClient}
            serverId={serverId}
            projectId={projectId}
            onRefresh={refresh}
            {...selection}
          />
        </Animated.View>
      </View>
    </TaskAuthorsContext.Provider>
  );
}

type LoadedTasksProps = {
  retainedState: SwarmTaskSurfaceState;
  board: SwarmTaskBoard;
  workspaceId: string;
  projectWorkspaceIds: readonly string[];
  knownWorkspaceIds: readonly string[];
  compact: boolean;
  online: boolean;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  queryClient: QueryClient | undefined;
  serverId: string;
  projectId?: string | null;
  onRefresh: () => void;
} & Pick<
  SwarmTaskSurfaceProps,
  | "plannerName"
  | "agentName"
  | "taskId"
  | "onOpenTask"
  | "onOpenReference"
  | "onScopeChange"
  | "presentation"
  | "defaultAgentId"
>;

function TaskLoadContent({
  query,
  unavailable,
  hydrated,
  connecting,
  online,
  active,
  ...props
}: Omit<LoadedTasksProps, "board"> & {
  query: UseQueryResult<SwarmTaskBoard, Error>;
  unavailable: string | null;
  hydrated: boolean;
  connecting: boolean;
  active: boolean;
}) {
  const { t } = useTranslation();
  if (unavailable)
    return (
      <Text style={styles.error} accessibilityRole="alert">
        {unavailable}
      </Text>
    );
  if (!online && !query.data)
    return (
      <TaskPlaceholder
        message={connecting ? t("swarm.tasks.connecting") : t("swarm.tasks.offline")}
      />
    );
  if (query.isPending || !hydrated)
    return (
      <View style={styles.center}>
        <ThemedLoadingSpinner uniProps={spinnerMapping} />
        <Text style={styles.meta}>{t("swarm.tasks.loading")}</Text>
      </View>
    );
  if (query.isError && !query.data)
    return (
      <View style={styles.center}>
        <Text style={styles.error} accessibilityRole="alert">
          {query.error.message}
        </Text>
        <Button variant="outline" size="sm" onPress={props.onRefresh}>
          {t("common.actions.retry")}
        </Button>
      </View>
    );
  if (!query.data) return null;
  return (
    <>
      {!online ? (
        <Text style={styles.error} accessibilityRole="alert">
          {t("swarm.tasks.offline")}
        </Text>
      ) : null}
      {query.isError ? (
        <Text style={styles.error} accessibilityRole="alert">
          {query.error.message}
        </Text>
      ) : null}
      <LoadedTasks board={query.data} online={online && active} {...props} />
    </>
  );
}

function workspaceIdsForHost(keys: readonly string[], serverId: string) {
  return keys
    .filter((key) => key.startsWith(`${serverId}:`))
    .map((key) => key.slice(serverId.length + 1));
}

function taskAvailability(input: {
  online: boolean;
  installed: boolean;
  hydrated: boolean;
  projectId: string | null;
  hasProject: boolean;
}) {
  if (input.online && !input.installed) return i18n.t("swarm.tasks.swarmUnavailable");
  if (input.hydrated && !input.projectId) return i18n.t("swarm.tasks.workspaceUnavailable");
  if (input.hydrated && input.projectId && !input.hasProject)
    return i18n.t("swarm.tasks.projectUnavailable");
  return null;
}

function TaskToolbar({
  label,
  compact,
  refreshing,
  disabled,
  onRefresh,
}: {
  label?: string;
  compact: boolean;
  refreshing: boolean;
  disabled: boolean;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.toolbar}>
      <View style={styles.heading}>
        <Text style={styles.title}>{t("swarm.tasks.title")}</Text>
        <Text style={styles.meta} numberOfLines={1}>
          {label}
        </Text>
      </View>
      <Button
        variant="ghost"
        size={compact ? "md" : "sm"}
        loading={refreshing}
        disabled={disabled}
        onPress={onRefresh}
        accessibilityLabel={t("swarm.tasks.refreshLabel")}
      >
        {t("swarm.tasks.refresh")}
      </Button>
    </View>
  );
}

function TaskPlaceholder({ message, onBack }: { message: string; onBack?: () => void }) {
  return (
    <View style={styles.detail}>
      {onBack ? <TaskBackHeader onBack={onBack} /> : null}
      <View style={styles.center}>
        <Text style={styles.meta}>{message}</Text>
      </View>
    </View>
  );
}

function TaskBackHeader({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  return (
    <View style={styles.backHeader}>
      <Button
        variant="ghost"
        size={compact ? "md" : "sm"}
        leftIcon={ArrowLeft}
        onPress={onBack}
        accessibilityLabel={`${t("common.actions.back")}, ${t("swarm.tasks.allTasks")}`}
        testID="swarm-task-back"
      >
        {t("common.actions.back")}
      </Button>
    </View>
  );
}

function LoadedTasks({
  retainedState,
  board,
  workspaceId,
  projectWorkspaceIds,
  knownWorkspaceIds,
  compact,
  online,
  invoke,
  queryClient,
  serverId,
  projectId,
  onRefresh,
  plannerName,
  agentName,
  taskId,
  onOpenTask,
  onOpenReference,
  onScopeChange,
  presentation = "main",
  defaultAgentId,
}: LoadedTasksProps) {
  const { t } = useTranslation();
  const initialScope = initialTaskScope(
    board,
    workspaceId,
    presentation,
    plannerName,
    agentName,
    defaultAgentId,
  );
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(
    taskId ?? retainedState.view.selectedTaskId,
  );
  // Keep visited detail roots in visit order: moving retained native roots loses editor identity.
  const [visitedTaskIds, setVisitedTaskIds] = useState<string[]>(() => {
    const ids = retainedState.view.visitedTaskIds;
    return taskId && !ids.includes(taskId) ? [...ids, taskId] : ids;
  });
  const [scope, setScope] = useState(retainedState.view.scope ?? initialScope);
  const [statuses, setStatuses] = useState<string[]>(retainedState.view.statuses);
  const [search, setSearch] = useState(retainedState.view.search);
  useLayoutEffect(() => {
    retainedState.view = { selectedTaskId, visitedTaskIds, scope, statuses, search };
  }, [retainedState, selectedTaskId, visitedTaskIds, scope, statuses, search]);
  const { onLayout, isBelow } = useContainerWidthBelow(SETTINGS_DESKTOP_SPLIT_MIN_WIDTH);
  const wide = !isBelow;
  const split = wide && Boolean(selectedTaskId);
  useEffect(() => {
    // Clearing explicit scope must restore Project/default scope without remounting drafts.
    setScope(initialScope);
  }, [agentName, plannerName, initialScope]);
  useEffect(() => {
    setSelectedTaskId(taskId ?? null);
    if (taskId) setVisitedTaskIds((ids) => (ids.includes(taskId) ? ids : [...ids, taskId]));
  }, [taskId]);
  useEffect(() => {
    if (
      presentation !== "explorer" ||
      plannerName !== undefined ||
      agentName !== undefined ||
      !initialScope
    )
      return;
    setScope(initialScope);
    onScopeChange?.(taskScopeSelection(board, initialScope));
    // The default seeds scope; a reference launch must keep its explicit Task selection.
    if (taskId) onOpenTask?.(taskId);
  }, [
    presentation,
    plannerName,
    agentName,
    initialScope,
    board,
    taskId,
    onScopeChange,
    onOpenTask,
  ]);
  const openTask = useCallback(
    (id: string) => {
      setVisitedTaskIds((ids) => (ids.includes(id) ? ids : [...ids, id]));
      setSelectedTaskId(id);
      onOpenTask?.(id);
    },
    [onOpenTask],
  );
  const back = useCallback(() => {
    setSelectedTaskId(null);
    onOpenTask?.(undefined);
  }, [onOpenTask]);
  const changeScope = useCallback(
    (value: string) => {
      setScope(value);
      onScopeChange?.(taskScopeSelection(board, value));
    },
    [board, onScopeChange],
  );
  const tasks = useMemo(
    () =>
      scopedSwarmTasks(board, {
        projectWorkspaceIds,
        knownWorkspaceIds,
        agentName: scope || undefined,
      }),
    [board, projectWorkspaceIds, knownWorkspaceIds, scope],
  );
  const filtered = useMemo(
    () => filterSwarmTasks(tasks, statuses, search),
    [tasks, statuses, search],
  );
  const lanes = useMemo(() => partitionSwarmTasks(filtered), [filtered]);
  const openLink = useSwarmCanonicalLinkPress();
  const {
    lane,
    setLane,
    showHistory,
    historySupported,
    showArtifacts,
    artifactsSupported,
    artifacts,
    history,
    historyTasks,
    knownTasks,
    loaded,
    lookingUp,
  } = useHistoryLane({
    board,
    search,
    online,
    serverId,
    projectId: projectId ?? null,
    invoke,
    queryClient,
    projectWorkspaceIds,
    knownWorkspaceIds,
    agentName: scope || undefined,
    selectedTaskId,
  });
  const toggleStatus = useCallback((value: string) => {
    setStatuses((current) => {
      if (!value) return [];
      if (current.includes(value)) return current.filter((status) => status !== value);
      return [...current, value];
    });
  }, []);
  const selected = [...tasks, ...loaded].find((task) => task.id === selectedTaskId);
  const scopeOptions = swarmTaskScopeOptions(board, projectWorkspaceIds, knownWorkspaceIds);
  const statusOptions = useMemo(
    () => [
      { value: "", label: t("swarm.tasks.allStatuses") },
      ...swarmTaskColumns(board, tasks).map(({ status: stage }) => ({
        value: stage,
        label: stage,
      })),
    ],
    [board, tasks, t],
  );
  const navigatorStyle = useMemo(
    () => [
      styles.navigator,
      split && styles.navigatorSplit,
      selectedTaskId && !split && styles.hidden,
    ],
    [selectedTaskId, split],
  );
  const detailHostStyle = useMemo(
    () => [styles.detailHost, !selectedTaskId && styles.hidden],
    [selectedTaskId],
  );
  const bodyStyle = useMemo(() => [styles.taskBody, split && styles.taskBodySplit], [split]);
  const showList = !showHistory && !showArtifacts;
  const shownArtifacts = useMemo(
    () => filterSwarmArtifacts(artifacts.artifacts, search),
    [artifacts.artifacts, search],
  );
  const showKanban = !selectedTaskId && presentation === "main" && wide && showList;
  return (
    <View style={styles.loaded} onLayout={onLayout}>
      <View style={bodyStyle}>
        <RetainedPanel
          active={!selectedTaskId || split}
          style={navigatorStyle}
          testID="swarm-task-navigator"
        >
          <TaskFilters
            inline={wide && !split}
            compact={compact}
            lane={lane}
            onLaneChange={setLane}
            historySupported={historySupported}
            artifactsSupported={artifactsSupported}
            scope={scope}
            scopeOptions={scopeOptions}
            onScopeChange={changeScope}
            search={search}
            onSearchChange={setSearch}
            statuses={statuses}
            statusOptions={statusOptions}
            onToggleStatus={toggleStatus}
            attention={swarmAttentionTotal(tasks)}
          />
          <RetainedPanel active={showKanban}>
            <TaskKanban
              tasks={lanes.open}
              delivered={lanes.closed}
              board={board}
              statuses={statuses}
              onOpen={openTask}
              invoke={invoke}
              onRefresh={onRefresh}
            />
          </RetainedPanel>
          <RetainedPanel active={!showKanban && showList}>
            <TaskRows
              tasks={lanes.open}
              delivered={lanes.closed}
              selectedTaskId={selectedTaskId}
              emptyMessage={
                tasks.length === 0 ? t("swarm.tasks.emptyScope") : t("swarm.tasks.noMatches")
              }
              onOpen={openTask}
            />
          </RetainedPanel>
          <RetainedPanel active={showHistory}>
            <TaskRows
              tasks={historyTasks}
              selectedTaskId={selectedTaskId}
              emptyMessage={
                history.loading ? t("swarm.tasks.loading") : t("swarm.tasks.emptyHistory")
              }
              onOpen={openTask}
            />
          </RetainedPanel>
          <RetainedPanel active={showArtifacts}>
            <SwarmArtifactList
              artifacts={shownArtifacts}
              searching={search.trim().length > 0}
              loading={artifacts.loading}
              onOpenLink={openLink}
              onOpenTask={openTask}
            />
          </RetainedPanel>
        </RetainedPanel>
        <View style={detailHostStyle} testID="swarm-task-detail-host">
          <RetainedPanel active={Boolean(selectedTaskId && !selected)}>
            <TaskPlaceholder
              message={lookingUp ? t("swarm.tasks.loading") : t("swarm.tasks.unavailableInScope")}
              onBack={back}
            />
          </RetainedPanel>
          {visitedTaskIds.map((id) => {
            const task = knownTasks.find((candidate) => candidate.id === id);
            if (!task) return null;
            const visible = selected?.id === id;
            return (
              <RetainedPanel key={id} active={visible}>
                <TaskDetail
                  retainedState={retainedState}
                  task={task}
                  board={board}
                  compact={compact}
                  onBack={back}
                  onOpenTask={openTask}
                  onOpenReference={onOpenReference}
                  invoke={invoke}
                  queryClient={queryClient}
                  serverId={serverId}
                  onRefresh={onRefresh}
                  online={online && visible}
                  knownWorkspaceIds={knownWorkspaceIds}
                />
              </RetainedPanel>
            );
          })}
        </View>
      </View>
    </View>
  );
}

function initialTaskScope(
  board: SwarmTaskBoard,
  workspaceId: string,
  presentation: "main" | "explorer",
  plannerName?: string,
  agentName?: string,
  defaultAgentId?: string,
) {
  if (agentName !== undefined) return agentName;
  if (plannerName !== undefined) return plannerName;
  return presentation === "explorer"
    ? defaultSwarmTaskScope(board, workspaceId, defaultAgentId)
    : "";
}

function taskScopeSelection(board: SwarmTaskBoard, value: string) {
  return findSwarmTaskAgent(board.agents, value)?.roleClass === "planner"
    ? { plannerName: value }
    : { agentName: value };
}

function TaskKanban({
  tasks,
  delivered,
  board,
  statuses,
  onOpen,
  invoke,
  onRefresh,
}: {
  tasks: readonly SwarmTask[];
  // Closed Tasks the current board still shows, as a last column.
  delivered: readonly SwarmTask[];
  board: SwarmTaskBoard;
  statuses: readonly string[];
  onOpen: (id: string) => void;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  // Closing a whole column as done is how a board from before resolutions is cleared.
  const closeSupported = board.features?.includes("close") ?? false;
  const columns = swarmTaskColumns(board, tasks).filter(
    (column) => statuses.length === 0 || statuses.includes(column.status),
  );
  if (!columns.length) return <TaskPlaceholder message={t("swarm.tasks.emptyScope")} />;
  return (
    <ScrollView
      horizontal
      style={styles.kanban}
      contentContainerStyle={styles.columns}
      testID="swarm-task-kanban"
    >
      {columns.map((column) => (
        <KanbanColumn
          key={column.status}
          label={column.status}
          tasks={column.tasks}
          closeSupported={closeSupported}
          invoke={invoke}
          onOpen={onOpen}
          onRefresh={onRefresh}
          testID={`swarm-column-${column.status}`}
        />
      ))}
      {delivered.length > 0 ? (
        <KanbanColumn
          label={t("swarm.tasks.delivered")}
          tasks={delivered}
          closeSupported={false}
          invoke={invoke}
          onOpen={onOpen}
          onRefresh={onRefresh}
          testID="swarm-column-delivered"
        />
      ) : null}
    </ScrollView>
  );
}

// One status of the board. The heading names it and counts its Tasks; the cards leave the status
// out, since the column says it. An empty status narrows to its heading, so the columns with cards
// stay in view. Closing a whole column as done is how a board from before resolutions is cleared,
// so it waits in the heading's menu.
function KanbanColumn({
  label,
  tasks,
  closeSupported,
  invoke,
  onOpen,
  onRefresh,
  testID,
}: {
  label: string;
  tasks: readonly SwarmTask[];
  closeSupported: boolean;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  onOpen: (id: string) => void;
  onRefresh: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const [closing, setClosing] = useState(false);
  const startClosing = useCallback(() => setClosing(true), []);
  const empty = tasks.length === 0;
  return (
    <View style={empty ? styles.columnEmpty : styles.column} testID={testID}>
      <View style={styles.columnHeading}>
        <Text style={empty ? styles.columnLabelEmpty : styles.columnLabel} numberOfLines={1}>
          {label}
        </Text>
        <Text style={styles.columnCount}>{tasks.length}</Text>
        {closeSupported && !empty ? (
          <View style={styles.columnActions}>
            <DropdownMenu>
              <DropdownMenuTrigger
                hitSlop={8}
                style={columnMenuTriggerStyle}
                accessibilityLabel={t("swarm.tasks.columnActions", { status: label })}
                testID={`${testID.replace("swarm-column-", "swarm-column-menu-")}`}
              >
                {renderColumnMenuIcon}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" width={200}>
                <DropdownMenuItem
                  onSelect={startClosing}
                  testID={`${testID.replace("swarm-column-", "swarm-column-close-")}`}
                >
                  {t("swarm.tasks.closeAllAsDone")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </View>
        ) : null}
      </View>
      {closing ? (
        <TaskCloseControl
          tasks={tasks}
          invoke={invoke}
          onClosed={onRefresh}
          open
          onOpenChange={setClosing}
          testID={`${testID.replace("swarm-column-", "swarm-column-close-")}`}
        />
      ) : null}
      {empty ? null : (
        <ScrollView contentContainerStyle={styles.columnCards} nestedScrollEnabled>
          {tasks.map((task) => (
            <SurfaceCard key={task.id}>
              <TaskRow
                task={task}
                selected={false}
                attention={task.attention}
                onOpen={onOpen}
                showStatus={false}
              />
            </SurfaceCard>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

function renderColumnMenuIcon({ hovered }: { hovered?: boolean }) {
  return (
    <ThemedMoreHorizontal
      size={ICON_SIZE.sm}
      uniProps={hovered ? foregroundIconMapping : mutedIconMapping}
    />
  );
}

function columnMenuTriggerStyle({
  hovered = false,
}: PressableStateCallbackType & { hovered?: boolean }) {
  return [styles.columnMenuTrigger, hovered && styles.columnMenuTriggerHovered];
}

function TaskRows({
  tasks,
  delivered,
  selectedTaskId,
  emptyMessage,
  onOpen,
}: {
  tasks: readonly SwarmTask[];
  // Closed Tasks the current board still shows, listed after the open ones.
  delivered?: readonly SwarmTask[];
  selectedTaskId: string | null;
  emptyMessage: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const row = (task: SwarmTask) => (
    <TaskRow
      key={task.id}
      task={task}
      selected={selectedTaskId === task.id}
      attention={task.attention}
      onOpen={onOpen}
    />
  );
  return (
    <ScrollView contentContainerStyle={styles.taskRows}>
      {tasks.length === 0 ? <Text style={styles.meta}>{emptyMessage}</Text> : tasks.map(row)}
      {delivered?.length ? (
        <View style={styles.lane} testID="swarm-task-delivered">
          <Text style={styles.laneHeading}>{t("swarm.tasks.delivered")}</Text>
          {delivered.map(row)}
        </View>
      ) : null}
    </ScrollView>
  );
}

type TaskLane = "board" | "history" | "artifacts";

// The view switch and the filters for it. They sit on one line beside the board and stack in a
// narrow list; on a phone both pickers share a line under the search. Artifacts belong to the project,
// so the Task scope and statuses do not apply to them.
function TaskFilters({
  inline,
  compact,
  lane,
  onLaneChange,
  historySupported,
  artifactsSupported,
  scope,
  scopeOptions,
  onScopeChange,
  search,
  onSearchChange,
  statuses,
  statusOptions,
  onToggleStatus,
  attention,
}: {
  inline: boolean;
  compact: boolean;
  lane: TaskLane;
  onLaneChange: (lane: TaskLane) => void;
  historySupported: boolean;
  artifactsSupported: boolean;
  scope: string;
  scopeOptions: Array<{ value: string; label: string }>;
  onScopeChange: (value: string) => void;
  search: string;
  onSearchChange: (value: string) => void;
  statuses: readonly string[];
  statusOptions: Array<{ value: string; label: string }>;
  onToggleStatus: (value: string) => void;
  attention: number;
}) {
  const { t } = useTranslation();
  const artifacts = lane === "artifacts";
  const findLabel = artifacts ? t("swarm.artifacts.find") : t("swarm.tasks.findTask");
  const style = useMemo(() => [styles.filters, inline && styles.filtersWide], [inline]);
  const scopeFilter = artifacts ? null : (
    <TaskSelect
      label={t("swarm.tasks.scope")}
      value={scope}
      options={scopeOptions}
      onSelect={onScopeChange}
    />
  );
  const statusFilter = artifacts ? null : (
    <TaskStatusFilter statuses={statuses} options={statusOptions} onToggle={onToggleStatus} />
  );
  return (
    <View style={style}>
      <TaskViewSwitch
        lane={lane}
        onChange={onLaneChange}
        historySupported={historySupported}
        artifactsSupported={artifactsSupported}
        compact={compact}
      />
      {inline ? scopeFilter : null}
      <View style={inline ? styles.searchWide : undefined}>
        <FormTextInput
          initialValue={search}
          size={compact ? "md" : "sm"}
          onChangeText={onSearchChange}
          placeholder={findLabel}
          accessibilityLabel={findLabel}
          testID="swarm-task-search"
        />
      </View>
      {inline ? statusFilter : null}
      {!inline && compact && !artifacts ? (
        <View style={styles.pickers}>
          <View style={styles.picker}>{scopeFilter}</View>
          <View style={styles.picker}>{statusFilter}</View>
        </View>
      ) : null}
      {!inline && !compact ? scopeFilter : null}
      {!inline && !compact ? statusFilter : null}
      {attention > 0 && !artifacts ? (
        <StatusBadge
          variant="warning"
          label={t("swarm.tasks.awaitingReply", { count: attention })}
        />
      ) : null}
    </View>
  );
}

// What the list shows: the current Tasks, closed ones, or the project's artifacts. Hosts from
// before History or artifacts offer only the views they have.
function TaskViewSwitch({
  lane,
  onChange,
  historySupported,
  artifactsSupported,
  compact,
}: {
  lane: TaskLane;
  onChange: (lane: TaskLane) => void;
  historySupported: boolean;
  artifactsSupported: boolean;
  compact: boolean;
}) {
  const { t } = useTranslation();
  const options = useMemo(
    () => [
      { value: "board" as const, label: t("swarm.tasks.current"), testID: "swarm-task-current" },
      ...(historySupported
        ? [
            {
              value: "history" as const,
              label: t("swarm.tasks.history"),
              testID: "swarm-task-history-toggle",
            },
          ]
        : []),
      ...(artifactsSupported
        ? [
            {
              value: "artifacts" as const,
              label: t("swarm.artifacts.title"),
              testID: "swarm-artifacts-toggle",
            },
          ]
        : []),
    ],
    [artifactsSupported, historySupported, t],
  );
  if (options.length < 2) return null;
  return (
    <SegmentedControl
      options={options}
      value={lane}
      onValueChange={onChange}
      size={compact ? "md" : "sm"}
      testID="swarm-task-view"
    />
  );
}

const EMPTY_TASKS: SwarmTask[] = [];

// The History lane: whether it is on, the closed Tasks it shows in the current scope, and every
// Task a detail can show, the current board's and the closed ones opened from History.
function useHistoryLane(input: {
  board: SwarmTaskBoard;
  search: string;
  online: boolean;
  serverId: string;
  projectId: string | null;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  queryClient: QueryClient | undefined;
  projectWorkspaceIds: readonly string[];
  knownWorkspaceIds: readonly string[];
  agentName: string | undefined;
  // A Task opened by id, such as from a closure relation, that may be off the current board.
  selectedTaskId: string | null;
}) {
  const { board, projectWorkspaceIds, knownWorkspaceIds, agentName } = input;
  // The list shows the board, closed Tasks, or the project's artifacts.
  const [lane, setLane] = useState<TaskLane>("board");
  const showHistory = lane === "history";
  const showArtifacts = lane === "artifacts";
  const historySupported = board.features?.includes("board") ?? false;
  const artifactsSupported = board.features?.includes("artifacts") ?? false;
  const artifacts = useSwarmArtifacts({
    serverId: input.serverId,
    projectId: input.projectId,
    invoke: input.invoke,
    queryClient: input.queryClient,
    enabled: showArtifacts && artifactsSupported && input.online,
  });
  const history = useSwarmTaskHistory({
    serverId: input.serverId,
    projectId: input.projectId,
    invoke: input.invoke,
    queryClient: input.queryClient,
    search: input.search,
    enabled: showHistory && historySupported && input.online,
  });
  const historyTasks = useMemo(
    () =>
      scopedSwarmTasks(
        { ...board, tasks: history.tasks },
        { projectWorkspaceIds, knownWorkspaceIds, agentName },
      ),
    [board, history.tasks, projectWorkspaceIds, knownWorkspaceIds, agentName],
  );
  const missing =
    input.selectedTaskId &&
    !board.tasks.some((task) => task.id === input.selectedTaskId) &&
    !history.seen.some((task) => task.id === input.selectedTaskId)
      ? input.selectedTaskId
      : "";
  // The history read matches ids, so a closed Task opened by id loads like one found by search.
  const lookup = useSwarmTaskHistory({
    serverId: input.serverId,
    projectId: input.projectId,
    invoke: input.invoke,
    queryClient: input.queryClient,
    search: missing,
    enabled: Boolean(missing) && historySupported && input.online,
  });
  const knownTasks = useMemo(() => {
    const known = new Set<string>();
    return [...board.tasks, ...history.seen, ...lookup.seen].filter((task) => {
      if (known.has(task.id)) return false;
      known.add(task.id);
      return true;
    });
  }, [board.tasks, history.seen, lookup.seen]);
  return {
    lane,
    setLane,
    showHistory,
    historySupported,
    showArtifacts,
    artifactsSupported,
    artifacts,
    history,
    historyTasks,
    knownTasks,
    // Closed Tasks this surface loaded from history, by search or by id.
    loaded: [...history.seen, ...lookup.seen],
    lookingUp: lookup.loading,
  };
}

// Closed Tasks off the current board, newest first, matching the search. Each Task the history
// has shown stays known, so a detail opened from it survives a new search.
function useSwarmTaskHistory(input: {
  serverId: string;
  projectId: string | null;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  queryClient: QueryClient | undefined;
  search: string;
  enabled: boolean;
}) {
  const { serverId, projectId, invoke, queryClient, enabled } = input;
  const search = input.search.trim();
  const queryKey = useMemo(
    () => ["swarm", "task-history", serverId, projectId, search],
    [serverId, projectId, search],
  );
  const query = useFetchQuery(
    {
      queryKey,
      queryFn: swarmConditionalQuery({
        queryClient,
        queryKey,
        schema: swarmTaskBoardSchema,
        read: (etag) =>
          invoke("swarm.tasks.read", {
            projectId: projectId ?? undefined,
            view: "history",
            ...(search ? { query: search } : {}),
            ...(etag ? { etag } : {}),
          }),
      }),
      select: selectSwarmValue<SwarmTaskBoard>,
      enabled: enabled && Boolean(projectId),
      dataShape: "value",
      staleTimeMs: SWARM_POLL_MS - 500,
    },
    queryClient,
  );
  const tasks = query.data?.tasks ?? EMPTY_TASKS;
  const [seen, setSeen] = useState<SwarmTask[]>(EMPTY_TASKS);
  useEffect(() => {
    if (tasks.length === 0) return;
    const ids = new Set(tasks.map((task) => task.id));
    setSeen((current) => [...current.filter((known) => !ids.has(known.id)), ...tasks]);
  }, [tasks]);
  return { tasks, seen, loading: enabled && query.isPending };
}

function TaskRow({
  task,
  selected,
  attention,
  onOpen,
  showStatus = true,
}: {
  task: SwarmTask;
  selected: boolean;
  attention: number;
  onOpen: (id: string) => void;
  // A board column already names the status.
  showStatus?: boolean;
}) {
  const { t } = useTranslation();
  const open = useCallback(() => onOpen(task.id), [onOpen, task.id]);
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [
      styles.taskRow,
      selected && styles.selectedRow,
      pressed && styles.pressedRow,
    ],
    [selected],
  );
  return (
    <Pressable
      onPress={open}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
      accessibilityLabel={`${task.title}, ${task.status}`}
      testID={`swarm-task-${task.id}`}
    >
      <Text style={styles.primary} numberOfLines={2}>
        {task.title}
      </Text>
      <View style={styles.rowMeta}>
        {/* A closed Task's status is where it stopped; how it closed is what a reader needs. */}
        {task.resolution ? <ResolutionBadge resolution={task.resolution} /> : null}
        {!task.resolution && showStatus ? <StatusBadge label={task.status} /> : null}
        <Text style={styles.meta} numberOfLines={1}>
          {task.managerName}
        </Text>
      </View>
      {attention > 0 ? (
        <StatusBadge
          variant="warning"
          label={t("swarm.tasks.awaitingReply", { count: attention })}
        />
      ) : null}
    </Pressable>
  );
}

// A Task's own read: its brief and closure details, with the Tasks merged into it.
type SwarmTaskRecord = SwarmTaskDetail["task"] & { absorbed?: SwarmTaskDetail["absorbed"] };

interface SwarmTaskDetailState {
  activities: readonly SwarmActivity[];
  brief: string | null;
  record: SwarmTaskRecord | null;
  // The read has answered at least once, so an empty list means no Activity.
  loaded: boolean;
  olderCount: number;
  canShowEarlier: boolean;
  loadingEarlier: boolean;
  error: string | null;
  showEarlier: () => void;
  refetch: () => void;
}

// One Task's brief and latest Activities, polled while its detail is shown. Earlier Activities
// load a page at a time on request.
function useSwarmTaskDetail(input: {
  serverId: string;
  task: SwarmTask;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  queryClient: QueryClient | undefined;
  enabled: boolean;
}): SwarmTaskDetailState {
  const { serverId, task, invoke, queryClient, enabled } = input;
  const [limit, setLimit] = useState(SWARM_TASK_ACTIVITY_PAGE);
  const queryKey = useMemo(
    () => ["swarm", "task", serverId, task.swarmId, task.id, limit],
    [serverId, task.swarmId, task.id, limit],
  );
  const query = useFetchQuery(
    {
      queryKey,
      queryFn: swarmConditionalQuery({
        queryClient,
        queryKey,
        schema: swarmTaskDetailSchema,
        read: (etag) =>
          invoke("swarm.task.read", {
            swarmId: task.swarmId,
            taskId: task.id,
            limit,
            ...(etag ? { etag } : {}),
          }),
      }),
      select: selectSwarmValue<SwarmTaskDetail>,
      enabled,
      refetchInterval: enabled ? SWARM_POLL_MS : false,
      // Keeps the shown page while a longer one loads.
      dataShape: "list",
      staleTimeMs: SWARM_POLL_MS - 500,
    },
    queryClient,
  );
  const { refetch } = query;
  const showEarlier = useCallback(
    () =>
      setLimit((current) => Math.min(current + SWARM_TASK_ACTIVITY_PAGE, SWARM_TASK_ACTIVITY_MAX)),
    [],
  );
  const refresh = useCallback(() => void refetch(), [refetch]);
  const olderCount = query.data?.olderCount ?? 0;
  const record = useMemo(
    () => (query.data ? { ...query.data.task, absorbed: query.data.absorbed } : null),
    [query.data],
  );
  return {
    activities: query.data?.activities ?? EMPTY_ACTIVITIES,
    brief: query.data?.task.brief ?? null,
    record,
    loaded: query.data !== undefined,
    olderCount,
    canShowEarlier: olderCount > 0 && limit < SWARM_TASK_ACTIVITY_MAX,
    loadingEarlier: query.isPlaceholderData,
    error: query.isError ? query.error.message : null,
    showEarlier,
    refetch: refresh,
  };
}

function TaskActivityStatus({
  detail,
  online,
  empty,
}: {
  detail: SwarmTaskDetailState;
  online: boolean;
  // Whether the actor filter leaves no Activity to show.
  empty: boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      {detail.canShowEarlier ? (
        <Button
          variant="ghost"
          size="sm"
          loading={detail.loadingEarlier}
          disabled={!online}
          onPress={detail.showEarlier}
          testID="swarm-task-earlier-activity"
        >
          {t("swarm.tasks.earlierActivity", { count: detail.olderCount })}
        </Button>
      ) : null}
      {detail.error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {detail.error}
        </Text>
      ) : null}
      {!detail.loaded && !detail.error ? (
        <Text style={styles.meta}>{t("swarm.tasks.loadingActivity")}</Text>
      ) : null}
      {detail.loaded && empty ? (
        <Text style={styles.meta}>{t("swarm.tasks.emptyActivity")}</Text>
      ) : null}
    </>
  );
}

function TaskDetail({
  retainedState,
  task,
  board,
  compact,
  onBack,
  onOpenTask,
  onOpenReference,
  invoke,
  queryClient,
  serverId,
  onRefresh,
  online,
  knownWorkspaceIds,
}: {
  retainedState: SwarmTaskSurfaceState;
  task: SwarmTask;
  board: SwarmTaskBoard;
  compact: boolean;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onOpenReference?: (reference: SwarmTaskReference) => void;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  queryClient: QueryClient | undefined;
  serverId: string;
  onRefresh: () => void;
  online: boolean;
  knownWorkspaceIds: readonly string[];
}) {
  const { t } = useTranslation();
  const active = useRetainedPanelActive();
  const taskDetail = useSwarmTaskDetail({
    serverId,
    task,
    invoke,
    queryClient,
    enabled: online && active,
  });
  const { activities, refetch: refetchDetail } = taskDetail;
  const { ccSupported, defaultCc } = useTaskCc(board, task.managerName);
  const [detail] = useState(() => retainedState.detail(task.id, activities, defaultCc));
  const model = detail.model;
  const reply = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const editor = useRef<EditingTextInputHandle>(null);
  const [actor, setActor] = useState(detail.actor);
  const [referenceUnavailable, setReferenceUnavailable] = useState(detail.referenceUnavailable);
  const activityScroll = useRef<ScrollView>(null);
  const [scrollReceiptId, setScrollReceiptId] = useState<string | null>(null);
  const scrollReceipt = useRef<string | null>(null);
  const receiptIncluded = useRef(false);
  useLayoutEffect(() => {
    receiptIncluded.current = Boolean(
      scrollReceiptId && !actor && activities.some((activity) => activity.id === scrollReceiptId),
    );
  }, [activities, actor, scrollReceiptId]);
  const scrollFrame = useRef<number | null>(null);
  const committedView = useRef({ mounted: false, active: false, actor, revision: 0 });
  useLayoutEffect(() => {
    committedView.current = {
      mounted: true,
      active,
      actor,
      revision: committedView.current.revision + 1,
    };
    if (!active || actor) setScrollReceiptId(null);
    return () => {
      committedView.current.mounted = false;
      committedView.current.active = false;
      committedView.current.revision += 1;
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [active, actor]);
  useLayoutEffect(() => {
    scrollReceipt.current = scrollReceiptId;
    return () => {
      scrollReceipt.current = null;
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [scrollReceiptId]);
  const revealSavedActivity = useCallback(() => {
    const current = committedView.current;
    if (
      !current.mounted ||
      !current.active ||
      current.actor ||
      !receiptIncluded.current ||
      !scrollReceiptId ||
      scrollReceipt.current !== scrollReceiptId
    )
      return;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      const view = committedView.current;
      if (
        !view.mounted ||
        !view.active ||
        view.actor ||
        !receiptIncluded.current ||
        scrollReceipt.current !== scrollReceiptId
      )
        return;
      // Consume only after the exact receipt's refreshed list has laid out.
      scrollReceipt.current = null;
      activityScroll.current?.scrollToEnd({ animated: false });
      setScrollReceiptId(null);
    });
  }, [scrollReceiptId]);
  const initialEditorState = useRef({
    selection: detail.selection,
    restoreFocus: active && !reply.pending && detail.restoreFocus,
  }).current;
  useLayoutEffect(() => {
    detail.actor = actor;
    detail.referenceUnavailable = referenceUnavailable;
  }, [detail, actor, referenceUnavailable]);
  const rememberSelection = useCallback<
    NonNullable<ComponentProps<typeof FormTextInput>["onSelectionChange"]>
  >(
    (event) => {
      detail.selection = event.nativeEvent.selection;
    },
    [detail],
  );
  useLayoutEffect(() => {
    const input = editor.current;
    // Receipt may have completed since the first render fixed initialValue.
    const text = model.getState().body;
    const selection = initialEditorState.selection
      ? {
          start: Math.min(initialEditorState.selection.start, text.length),
          end: Math.min(initialEditorState.selection.end, text.length),
        }
      : undefined;
    if (selection || input?.getText() !== text) input?.replaceText(text, selection);
    detail.restoreFocus = false;
    let pending = model.getState().pending;
    const unsubscribe = model.subscribe(() => {
      const next = model.getState();
      // A send started in the previous shell clears this shell's editing owner too.
      if (pending && !next.pending && !next.error && next.body === "") {
        input?.replaceText("");
        detail.selection = null;
      }
      pending = next.pending;
    });
    return () => {
      detail.restoreFocus = input?.isFocused() ?? false;
      unsubscribe();
    };
  }, [detail, model, initialEditorState]);
  useEffect(() => {
    model.applyActivities(activities);
  }, [activities, model]);
  useEffect(() => {
    model.applyDefaultCc(defaultCc);
  }, [defaultCc, model]);
  const result = useMemo(() => swarmTaskResult(activities), [activities]);
  const record = taskDetail.record;
  const unbriefed = useMemo(
    () => notesNotInBrief({ briefUpdatedAt: record?.briefUpdatedAt }, activities),
    [record?.briefUpdatedAt, activities],
  );
  useEffect(() => {
    model.refreshTranslations();
  }, [model, t]);

  const visible = activities.filter((activity) => !actor || activity.actorName === actor);
  const actors = useMemo(
    () => [...new Set(activities.map((activity) => activity.actorName))],
    [activities],
  );
  const target = activities.find((activity) => activity.id === reply.replyTo);
  const profiles = target ? activityChoice(target)?.responseProfiles : undefined;
  const choices = unansweredChoices(activities);
  const openAgent = useCallback(
    (name: string) => {
      const agent = findSwarmTaskAgent(board.agents, name);
      if (!agent?.paseoAgentId) {
        setActor(name);
        return;
      }
      onOpenReference?.({
        kind: "agent",
        paseoAgentId: agent.paseoAgentId,
        qualifiedName: agent.qualifiedName ?? agent.name,
        workspaceId: agent.workspaceId,
      });
    },
    [board.agents, onOpenReference],
  );
  const openLink = useCallback(
    (uri: string) => {
      if (!/^paseo-swarm:\/\//i.test(uri)) return true;
      const open = (link: string) => {
        const reference = resolveSwarmTaskReference(link, board, knownWorkspaceIds);
        if (!reference) {
          setReferenceUnavailable(true);
          return;
        }
        setReferenceUnavailable(false);
        if (reference.kind === "task" && !reference.workspaceId) onOpenTask(reference.taskId);
        else onOpenReference?.(reference);
      };
      // A link to an artifact's source opens its copy, as it does from a reply or a seat's results.
      if (!/^paseo-swarm:\/\/file\//i.test(uri)) open(uri);
      else
        void resolveArtifactCopyLink({ serverId, invoke, queryClient }, uri).then((copy) =>
          open(copy ?? uri),
        );
      return false;
    },
    [board, invoke, knownWorkspaceIds, onOpenReference, onOpenTask, queryClient, serverId],
  );
  const send = useCallback(async () => {
    if (!online || model.getState().pending) return;
    // Read the editing owner once at submission, including the latest committed keystroke.
    model.setBody(editor.current?.getText() ?? model.getState().body);
    if (!model.getState().canSubmit) return;
    const viewRevision = committedView.current.revision;
    let savedReceiptId: string | null = null;
    const sent = await model.submit(async (input) => {
      const { cc, ...note } = input;
      const receipt = swarmHumanActivityReceiptSchema.parse(
        // Task ids are unique only within a swarm.
        await invoke("swarm.activity.append_human", {
          ...note,
          ...(cc.length > 0 ? { cc } : {}),
          swarmId: task.swarmId,
        }),
      );
      savedReceiptId = receipt.id;
      return receipt;
    });
    if (sent) {
      editor.current?.replaceText("");
      const current = committedView.current;
      if (
        savedReceiptId &&
        current.mounted &&
        current.active &&
        current.revision === viewRevision
      ) {
        // A successful local send reveals its human Activity through the existing All actors view.
        setActor("");
        setScrollReceiptId(savedReceiptId);
      }
      onRefresh();
      refetchDetail();
    }
  }, [invoke, model, onRefresh, online, refetchDetail, task.swarmId]);
  const handleActivityKeyPress = useCallback<
    NonNullable<ComponentProps<typeof FormTextInput>["onKeyPress"]>
  >(
    (event) => {
      const key = event.nativeEvent as Parameters<typeof isSwarmActivitySubmitShortcut>[0];
      if (!isSwarmActivitySubmitShortcut(key)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!key.repeat) void send();
    },
    [send],
  );
  const setProfile = useCallback(
    (value: string) => {
      const profile = responseProfiles.find((candidate) => candidate.value === value);
      if (profile) model.setProfile(profile.value);
    },
    [model],
  );
  const actorFilter = useMemo(
    () => (
      <TaskSelect
        label={t("swarm.tasks.activityActor")}
        value={actor}
        options={[
          { value: "", label: t("swarm.tasks.allActors") },
          ...actors.map((value) => ({ value, label: value })),
        ]}
        onSelect={setActor}
      />
    ),
    [actor, actors, t],
  );
  const cancelReply = useMemo(
    () =>
      reply.replyTo ? (
        <Button variant="ghost" size="sm" disabled={reply.pending} onPress={model.cancelReply}>
          {t("swarm.tasks.cancelReply")}
        </Button>
      ) : null,
    [reply.replyTo, reply.pending, model, t],
  );
  return (
    <View style={styles.detail} testID="swarm-task-detail">
      <TaskBackHeader onBack={onBack} />
      {referenceUnavailable ? (
        <Text style={styles.error} accessibilityRole="alert">
          {t("swarm.tasks.referenceUnavailable")}
        </Text>
      ) : null}
      <ScrollView
        ref={activityScroll}
        contentContainerStyle={styles.detailContent}
        keyboardShouldPersistTaps="handled"
      >
        <TaskSummary
          task={task}
          record={taskDetail.record}
          result={result}
          unbriefedCount={unbriefed.size}
          onOpenActor={openAgent}
          onOpenTask={onOpenTask}
          onLinkPress={openLink}
        />
        <TaskCloseAction
          task={task}
          board={board}
          invoke={invoke}
          onRefresh={onRefresh}
          refetchDetail={refetchDetail}
        />
        <SettingsSection title={t("swarm.tasks.activity")} flush trailing={actorFilter}>
          <TaskActivityStatus detail={taskDetail} online={online} empty={visible.length === 0} />
          {visible.map((activity) => (
            <ActivityRow
              key={activity.id}
              activity={activity}
              revised={result.revised.has(activity.id)}
              notInBrief={unbriefed.has(activity.id)}
              canChoose={choices.some((choice) => choice.id === activity.id)}
              selectedOption={reply.replyTo === activity.id ? reply.selectedOption : null}
              onReply={model.replyTo}
              pending={reply.pending}
              onOpenActor={openAgent}
              onLinkPress={openLink}
            />
          ))}
          {scrollReceiptId &&
          active &&
          !actor &&
          visible.some((activity) => activity.id === scrollReceiptId) ? (
            <View
              key={scrollReceiptId}
              collapsable={false}
              pointerEvents="none"
              accessible={false}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              style={styles.receiptLayoutMarker}
              onLayout={revealSavedActivity}
            />
          ) : null}
        </SettingsSection>
      </ScrollView>
      <View style={styles.composer}>
        {reply.notificationWarning ? (
          <Text style={styles.meta} accessibilityRole="alert">
            {t("swarm.tasks.notificationFailed", { reason: reply.notificationWarning })}
          </Text>
        ) : null}
        {ccSupported ? (
          <SwarmCcLine
            recipient={task.managerName}
            cc={reply.cc}
            defaultCc={defaultCc}
            disabled={reply.pending}
            onRemove={model.removeCc}
            onRestore={model.restoreCc}
          />
        ) : null}
        <Field
          label={
            reply.replyTo
              ? t("swarm.tasks.replyTo", { actor: target?.actorName ?? reply.replyTo })
              : t("swarm.tasks.addActivity")
          }
          error={reply.error}
          testID="swarm-activity-field"
          trailing={cancelReply}
        >
          <FormTextInput
            ref={editor}
            initialValue={reply.body}
            autoFocus={initialEditorState.restoreFocus}
            onSelectionChange={rememberSelection}
            size={compact ? "md" : "sm"}
            multiline
            onChangeText={model.setBody}
            onKeyPress={handleActivityKeyPress}
            editable={!reply.pending}
            placeholder={t("swarm.tasks.writeActivity")}
            accessibilityLabel={t("swarm.tasks.activityMessage")}
            style={styles.editor}
            testID="swarm-activity-input"
          />
        </Field>
        <View style={styles.sendRow}>
          <TaskSelect
            label={t("swarm.tasks.responseProfile")}
            value={reply.responseProfile}
            options={responseProfiles
              .filter((profile) => !profiles || profiles.includes(profile.value))
              .map((profile) => ({ value: profile.value, label: t(profile.labelKey) }))}
            onSelect={setProfile}
            disabled={reply.pending}
          />
          <Button
            variant="default"
            size={compact ? "md" : "sm"}
            loading={reply.pending}
            disabled={!reply.canSubmit || !online}
            onPress={send}
            testID="swarm-activity-send"
          >
            {t("swarm.tasks.sendActivity")}
          </Button>
        </View>
      </View>
    </View>
  );
}

function ActivityRow({
  activity,
  revised,
  notInBrief,
  canChoose,
  selectedOption,
  onReply,
  pending,
  onOpenActor,
  onLinkPress,
}: {
  activity: SwarmActivity;
  revised: boolean;
  notInBrief: boolean;
  canChoose: boolean;
  selectedOption: string | null;
  onReply: (id: string, option?: string | null) => void;
  pending: boolean;
  onOpenActor: (name: string) => void;
  onLinkPress: (uri: string) => boolean;
}) {
  const { t } = useTranslation();
  const choice = activityChoice(activity);
  const reply = useCallback(() => onReply(activity.id), [onReply, activity.id]);
  const revises = typeof activity.data.revises === "string" ? activity.data.revises : null;
  if (activity.kind === CHANGE_KIND) {
    return (
      <View style={styles.change} testID={`swarm-activity-${activity.id}`}>
        <Text style={styles.meta}>
          {activity.actorName} · {new Date(activity.createdAt).toLocaleString()}
        </Text>
        <AudienceLine activity={activity} />
        <AuthoredMarkdown
          text={activity.body}
          author={activity.actorName}
          onLinkPress={onLinkPress}
        />
      </View>
    );
  }
  return (
    <View style={styles.activity} testID={`swarm-activity-${activity.id}`}>
      <View style={styles.activityHeader}>
        {activity.actorKind === "agent" ? (
          <PersonLink name={activity.actorName} onOpen={onOpenActor} />
        ) : (
          <Text style={styles.metaStrong}>{activity.actorName}</Text>
        )}
        <Text style={styles.meta}>
          {activity.kind === "delivery" ? t("swarm.tasks.result") : activity.kind}
          {activity.responseProfile ? ` · ${activity.responseProfile}` : ""}
        </Text>
        {revised ? <StatusBadge size="xs" label={t("swarm.tasks.revised")} /> : null}
        {notInBrief ? (
          <StatusBadge size="xs" variant="warning" label={t("swarm.tasks.notInBrief")} />
        ) : null}
        <View style={styles.activityTrailing}>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onPress={reply}
            accessibilityLabel={t("swarm.tasks.replyAccessibility", { actor: activity.actorName })}
          >
            {t("swarm.tasks.reply")}
          </Button>
        </View>
      </View>
      <Text style={styles.meta}>
        {new Date(activity.createdAt).toLocaleString()}
        {activity.replyTo ? ` · ${t("swarm.tasks.replyToActivity", { id: activity.replyTo })}` : ""}
        {revises ? ` · ${t("swarm.tasks.revises", { id: revises })}` : ""}
      </Text>
      <AudienceLine activity={activity} />
      <AuthoredMarkdown
        text={activity.body}
        author={activity.actorName}
        onLinkPress={onLinkPress}
      />
      <DeliveredArtifacts
        artifacts={activity.deliveredArtifacts}
        onOpenLink={onLinkPress}
        testID={`swarm-activity-artifacts-${activity.id}`}
      />
      {choice && canChoose ? (
        <View style={styles.choices}>
          <Text style={styles.primary}>{choice.prompt}</Text>
          {choice.options.map((option) => (
            <ChoiceOption
              key={option.id}
              activityId={activity.id}
              option={option}
              selected={selectedOption === option.id}
              pending={pending}
              onReply={onReply}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

function useTaskAuthors(serverId: string, board: SwarmTaskBoard | undefined) {
  const agents = board?.agents ?? NO_AGENTS;
  return useMemo(() => ({ serverId, agents }), [serverId, agents]);
}

// A note on a Task goes to its owner; on hosts that take a Cc, it copies the owner's manager.
function useTaskCc(board: SwarmTaskBoard, owner: string) {
  const ccSupported = board.features?.includes("cc") ?? false;
  const key = ccSupported ? defaultSwarmCc(board.agents, owner).join("\n") : "";
  const defaultCc = useMemo(() => (key ? key.split("\n") : NO_CC), [key]);
  return { ccSupported, defaultCc };
}

// The Task as agreed and as delivered: brief, current result, and the seats on it.
function TaskSummary({
  task,
  record,
  result,
  unbriefedCount,
  onOpenActor,
  onOpenTask,
  onLinkPress,
}: {
  task: SwarmTask;
  // The Task's own read: its brief and closure details, null until it loads.
  record: SwarmTaskRecord | null;
  result: ReturnType<typeof swarmTaskResult>;
  unbriefedCount: number;
  onOpenActor: (name: string) => void;
  onOpenTask: (id: string) => void;
  onLinkPress: (uri: string) => boolean;
}) {
  const { t } = useTranslation();
  return (
    <>
      <View style={styles.rowMeta}>
        <Text style={styles.title}>{task.title}</Text>
        <StatusBadge label={task.status} />
        {task.resolution ? <ResolutionBadge resolution={task.resolution} /> : null}
      </View>
      <Text style={styles.meta}>{task.id}</Text>
      <TaskClosure task={task} absorbed={record?.absorbed} onOpenTask={onOpenTask} />
      {record?.brief ? (
        <AuthoredMarkdown text={record.brief} author={task.managerName} onLinkPress={onLinkPress} />
      ) : null}
      {record && !record.brief ? (
        <Text style={styles.meta} testID="swarm-task-brief-pending">
          {t("swarm.tasks.briefPending", { owner: task.managerName })}
        </Text>
      ) : null}
      <BriefUnconfirmed author={record?.briefUnconfirmedBy} owner={task.managerName} />
      {unbriefedCount > 0 ? (
        <Text style={styles.meta} testID="swarm-task-notes-not-in-brief">
          {t("swarm.tasks.notesNotInBrief", { count: unbriefedCount })}
        </Text>
      ) : null}
      {result.latest ? (
        <TaskResult
          delivery={result.latest}
          revised={result.revised.has(result.latest.id)}
          onOpenActor={onOpenActor}
          onLinkPress={onLinkPress}
        />
      ) : null}
      <View style={styles.participants}>
        <View style={styles.participant}>
          <Text style={styles.meta}>{t("swarm.tasks.owner")}</Text>
          <PersonLink name={task.managerName} onOpen={onOpenActor} />
        </View>
        <View style={styles.participant}>
          <Text style={styles.meta}>{t("swarm.tasks.createdBy")}</Text>
          <PersonLink name={task.createdBy} onOpen={onOpenActor} />
        </View>
        <Requester
          requester={record?.requester}
          createdBy={task.createdBy}
          onOpenActor={onOpenActor}
        />
        {task.workerNames.length ? (
          <View style={styles.participant}>
            {task.workerNames.map((name) => (
              <PersonLink key={name} name={name} onOpen={onOpenActor} />
            ))}
          </View>
        ) : null}
      </View>
    </>
  );
}

// The human's Close as done for an open Task, on hosts that support it. Its owner is told.
function TaskCloseAction({
  task,
  board,
  invoke,
  onRefresh,
  refetchDetail,
}: {
  task: SwarmTask;
  board: SwarmTaskBoard;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  onRefresh: () => void;
  refetchDetail: () => void;
}) {
  const target = useMemo(() => [task], [task]);
  const afterClose = useCallback(() => {
    onRefresh();
    refetchDetail();
  }, [onRefresh, refetchDetail]);
  if (task.resolution || !board.features?.includes("close")) return null;
  return (
    <TaskCloseControl
      tasks={target}
      owner={task.managerName}
      invoke={invoke}
      onClosed={afterClose}
      testID="swarm-task-close"
    />
  );
}

// How a closed Task ended and what replaced it, and the Tasks merged into this one. Closure is
// history, so this never changes the brief or the result. Each related Task opens from here.
function TaskClosure({
  task,
  absorbed,
  onOpenTask,
}: {
  task: SwarmTask;
  absorbed: SwarmTaskDetail["absorbed"];
  onOpenTask: (id: string) => void;
}) {
  const { t } = useTranslation();
  const closedBy = task.resolution && task.resolvedBy;
  if (!task.duplicateOf && !task.supersededBy && !closedBy && !absorbed?.length) return null;
  return (
    <View testID="swarm-task-closure">
      {task.duplicateOf ? (
        <TaskRelation
          text={t("swarm.tasks.duplicateOf", { id: RELATION_MARK })}
          ids={[task.duplicateOf]}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {task.supersededBy ? (
        <TaskRelation
          text={t("swarm.tasks.supersededBy", { id: RELATION_MARK })}
          ids={[task.supersededBy]}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {absorbed?.length ? (
        <TaskRelation
          text={t("swarm.tasks.absorbed", { ids: RELATION_MARK })}
          ids={absorbed.map((entry) => entry.id)}
          onOpenTask={onOpenTask}
        />
      ) : null}
      {closedBy ? (
        <Text style={styles.meta}>{t("swarm.tasks.closedBy", { name: closedBy })}</Text>
      ) : null}
    </View>
  );
}

// Stands in for the Task ids in a translated relation, so the ids render as buttons wherever the
// locale puts them.
const RELATION_MARK = "\u0000";

function TaskRelation({
  text,
  ids,
  onOpenTask,
}: {
  text: string;
  ids: readonly string[];
  onOpenTask: (id: string) => void;
}) {
  const [before, after = ""] = text.split(RELATION_MARK);
  return (
    <View style={styles.relation}>
      {before ? <Text style={styles.meta}>{before.trim()}</Text> : null}
      {ids.map((id) => (
        <TaskLinkButton key={id} id={id} onOpen={onOpenTask} />
      ))}
      {after.trim() ? <Text style={styles.meta}>{after.trim()}</Text> : null}
    </View>
  );
}

function TaskLinkButton({ id, onOpen }: { id: string; onOpen: (id: string) => void }) {
  const open = useCallback(() => onOpen(id), [onOpen, id]);
  return (
    <Button variant="ghost" size="sm" onPress={open} testID={`swarm-task-relation-${id}`}>
      {id}
    </Button>
  );
}

// A brief another seat wrote, such as one recorded for work already underway, until its owner
// writes it or delivers.
function BriefUnconfirmed({ author, owner }: { author: string | undefined; owner: string }) {
  const { t } = useTranslation();
  if (!author || author === owner) return null;
  return (
    <View style={styles.rowMeta} testID="swarm-task-brief-unconfirmed">
      <StatusBadge
        size="xs"
        variant="warning"
        label={t("swarm.tasks.briefUnconfirmed", { author, owner })}
      />
    </View>
  );
}

// Who asked for the work, when that is not whoever recorded it.
function Requester({
  requester,
  createdBy,
  onOpenActor,
}: {
  requester: string | undefined;
  createdBy: string;
  onOpenActor: (name: string) => void;
}) {
  const { t } = useTranslation();
  if (!requester || requester === createdBy) return null;
  return (
    <View style={styles.participant}>
      <Text style={styles.meta}>{t("swarm.tasks.requestedBy")}</Text>
      {requester === PERSON_SENDER ? (
        <Text style={styles.metaStrong}>{requester}</Text>
      ) : (
        <PersonLink name={requester} onOpen={onOpenActor} />
      )}
    </View>
  );
}

// Who an Activity reached: To, then Cc, including recipients Swarm added.
function AudienceLine({ activity }: { activity: Pick<SwarmActivity, "audience"> }) {
  const { t } = useTranslation();
  const audience = swarmAudience(activity);
  if (!audience) return null;
  const parts = [
    ...(audience.to.length ? [t("swarm.tasks.audienceTo", { names: audience.to.join(", ") })] : []),
    ...(audience.cc.length ? [t("swarm.tasks.audienceCc", { names: audience.cc.join(", ") })] : []),
  ];
  return (
    <Text style={styles.meta} testID="swarm-activity-audience">
      {parts.join(" · ")}
    </Text>
  );
}

// Markdown a seat wrote. Paths it wrote in inline code open in that seat's workspace.
function AuthoredMarkdown({
  text,
  author,
  onLinkPress,
}: {
  text: string;
  author: string;
  onLinkPress: (uri: string) => boolean;
}) {
  const authors = useContext(TaskAuthorsContext);
  const seat = authors ? findSwarmTaskAgent(authors.agents, author) : undefined;
  const workspaceId = seat?.workspaceId ?? null;
  const workspaceRoot = useWorkspaceDirectory(authors?.serverId ?? null, workspaceId);
  const inlineCodeHref = useCallback(
    (content: string) =>
      workspaceId ? swarmArtifactHref(content, { workspaceId, workspaceRoot }) : null,
    [workspaceId, workspaceRoot],
  );
  return (
    <TaskMarkdown text={text} compact inlineCodeHref={inlineCodeHref} onLinkPress={onLinkPress} />
  );
}

function ResolutionBadge({ resolution }: { resolution: string }) {
  const { t } = useTranslation();
  return (
    <StatusBadge
      variant={resolution === "done" ? "success" : "muted"}
      label={t(`swarm.tasks.resolutions.${resolution}`, { defaultValue: resolution })}
    />
  );
}

// The Task's newest delivery, shown above the history as its current result.
function TaskResult({
  delivery,
  revised,
  onOpenActor,
  onLinkPress,
}: {
  delivery: SwarmActivity;
  revised: boolean;
  onOpenActor: (name: string) => void;
  onLinkPress: (uri: string) => boolean;
}) {
  const { t } = useTranslation();
  const stage = delivery.data.taskState === "open";
  return (
    <SurfaceCard style={styles.result} testID="swarm-task-result">
      <View style={styles.activityHeader}>
        <Text style={styles.label}>
          {stage ? t("swarm.tasks.stageResult") : t("swarm.tasks.result")}
        </Text>
        {revised ? <StatusBadge size="xs" label={t("swarm.tasks.revised")} /> : null}
      </View>
      <View style={styles.metaLine}>
        <PersonLink name={delivery.actorName} onOpen={onOpenActor} />
        <Text style={styles.meta}>· {new Date(delivery.createdAt).toLocaleString()}</Text>
      </View>
      <AudienceLine activity={delivery} />
      <AuthoredMarkdown
        text={delivery.body}
        author={delivery.actorName}
        onLinkPress={onLinkPress}
      />
      <DeliveredArtifacts
        artifacts={delivery.deliveredArtifacts}
        onOpenLink={onLinkPress}
        testID="swarm-task-result-artifacts"
      />
    </SurfaceCard>
  );
}

// A seat named in a line of metadata; it opens the seat.
function PersonLink({ name, onOpen }: { name: string; onOpen: (name: string) => void }) {
  const open = useCallback(() => onOpen(name), [onOpen, name]);
  return <SwarmInlineLink label={name} onPress={open} />;
}

function ChoiceOption({
  activityId,
  option,
  selected,
  pending,
  onReply,
}: {
  activityId: string;
  option: { id: string; label: string; description?: string };
  selected: boolean;
  pending: boolean;
  onReply: (id: string, option?: string | null) => void;
}) {
  const choose = useCallback(
    () => onReply(activityId, option.id),
    [onReply, activityId, option.id],
  );
  const accessibilityState = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={styles.choice}>
      <Button
        variant={selected ? "secondary" : "outline"}
        size="sm"
        disabled={pending}
        onPress={choose}
        accessibilityState={accessibilityState}
        testID={`swarm-choice-${option.id}`}
      >
        {option.label}
      </Button>
      {option.description ? <Text style={styles.meta}>{option.description}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  root: { flex: 1, minWidth: 0, backgroundColor: theme.colors.surface0 },
  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  heading: { flex: 1, minWidth: 0, gap: theme.spacing[1] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
    flexShrink: 1,
  },
  primary: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[3],
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  loaded: { flex: 1, minHeight: 0 },
  taskBody: { flex: 1, minHeight: 0 },
  taskBodySplit: { flexDirection: "row" },
  navigator: { flex: 1, minWidth: 0, minHeight: 0 },
  navigatorSplit: {
    flex: 0,
    flexBasis: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    flexShrink: 0,
    width: SETTINGS_DESKTOP_SIDEBAR_WIDTH,
    backgroundColor: theme.colors.surfaceSidebar,
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
  },
  detailHost: { flex: 1, minWidth: 0, minHeight: 0 },
  hidden: { display: "none" },
  kanban: { flex: 1 },
  columns: { gap: theme.spacing[3], padding: theme.spacing[3] },
  column: { width: 260, gap: theme.spacing[2] },
  columnEmpty: { gap: theme.spacing[2], maxWidth: 160 },
  // The heading's text starts on the cards' text rail: the card's border and the row's padding.
  columnHeading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 28,
    paddingHorizontal: theme.spacing[2] + theme.borderWidth[1],
  },
  columnLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  columnLabelEmpty: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    flexShrink: 1,
  },
  columnCount: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  columnActions: { marginLeft: "auto" },
  columnMenuTrigger: { padding: 2, borderRadius: 4 },
  columnMenuTriggerHovered: { backgroundColor: theme.colors.surface2 },
  columnCards: { gap: theme.spacing[2], paddingBottom: theme.spacing[3] },
  filters: { padding: theme.spacing[3], gap: theme.spacing[2] },
  filtersWide: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  searchWide: { flex: 1, minWidth: 160 },
  pickers: { flexDirection: "row", gap: theme.spacing[2] },
  picker: { flex: 1, minWidth: 0 },
  taskRows: { padding: theme.spacing[2], gap: theme.spacing[1] },
  lane: { gap: theme.spacing[1], paddingTop: theme.spacing[3] },
  relation: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[1] },
  laneHeading: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
  },
  taskRow: {
    minHeight: 64,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  selectedRow: { backgroundColor: theme.colors.surfaceSidebarSelected },
  pressedRow: { backgroundColor: theme.colors.surface2 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  detail: { flex: 1, minWidth: 0 },
  backHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  detailContent: { padding: theme.spacing[4], gap: theme.spacing[2] },
  participants: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    columnGap: theme.spacing[4],
    rowGap: theme.spacing[1],
    marginBottom: theme.spacing[2],
  },
  // A label and the names it introduces, a space apart.
  participant: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1] },
  metaLine: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[1] },
  metaStrong: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  label: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  activityTrailing: { marginLeft: "auto" },
  activity: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing[3],
    gap: theme.spacing[1],
  },
  activityHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  change: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing[2],
  },
  result: { padding: theme.spacing[3], gap: theme.spacing[1] },
  choices: { gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
  choice: { alignItems: "flex-start", gap: theme.spacing[1] },
  receiptLayoutMarker: { position: "absolute", bottom: 0, width: 0, height: 0 },
  composer: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    padding: theme.spacing[3],
    gap: theme.spacing[2],
  },
  editor: { minHeight: 64, maxHeight: 160, textAlignVertical: "top" },
  sendRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-end",
    alignItems: "center",
    gap: theme.spacing[2],
  },
}));
