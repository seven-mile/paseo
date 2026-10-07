import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import Animated from "react-native-reanimated";
import type { UseQueryResult } from "@tanstack/react-query";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { isNative } from "@/constants/platform";
import { useKeyboardShiftStyle } from "@/keyboard/shift";
import type { Theme } from "@/styles/theme";
import { MarkdownRenderer } from "@/components/markdown/renderer";
import { SettingsSection } from "@/components/settings/headings/settings-section";
import { Button } from "@/components/ui/button";
import { SurfaceCard } from "@/components/ui/scrollable-code-surface";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { StatusBadge } from "@/components/ui/status-badge";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeConnectionStatus } from "@/runtime/host-runtime";
import {
  useHasHydratedWorkspaces,
  useWorkspaceFields,
  useWorkspaceStructure,
} from "@/stores/session-store-hooks";
import { useSwarmRpc } from "./rpc";
import {
  activityChoice,
  defaultSwarmTaskScope,
  findSwarmTaskAgent,
  openSwarmReply,
  responseProfiles,
  resolveSwarmTaskReference,
  scopedSwarmTasks,
  swarmTaskBoardSchema,
  swarmHumanActivityReceiptSchema,
  swarmTaskScopeOptions,
  swarmTaskColumns,
  unansweredChoices,
  type SwarmActivity,
  type SwarmTask,
  type SwarmTaskBoard,
  type SwarmTaskReference,
} from "./task-model";

export interface SwarmTaskSurfaceProps {
  serverId: string;
  workspaceId: string;
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
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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
}: {
  value: string;
  label: string;
  selected: boolean;
  onSelect: (value: string) => void;
}) {
  const select = useCallback(() => onSelect(value), [onSelect, value]);
  return (
    <DropdownMenuItem selected={selected} onSelect={select}>
      {label}
    </DropdownMenuItem>
  );
}

export function SwarmTaskSurface(props: SwarmTaskSurfaceProps) {
  // Changing hosts or scope creates a new selection and composer lifetime.
  return (
    <TaskSurface
      key={`${props.serverId}:${props.workspaceId}:${props.plannerName ?? ""}:${props.agentName ?? ""}`}
      {...props}
    />
  );
}

function TaskSurface({
  serverId,
  workspaceId,
  isActive = true,
  keyboardInsetHandled = false,
  ...selection
}: SwarmTaskSurfaceProps) {
  useTranslation();
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
  const query = useFetchQuery(
    {
      queryKey: ["swarm", "task-board", serverId, projectId],
      queryFn: async () =>
        swarmTaskBoardSchema.parse(
          await invoke("swarm.board.read", { projectId: projectId ?? undefined }),
        ),
      enabled: Boolean(plugin) && Boolean(projectId) && hydrated && online && active,
      dataShape: "value",
      staleTimeMs: 2500,
      refetchInterval: active ? 3000 : false,
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
  return (
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
          query={query}
          unavailable={unavailable}
          hydrated={hydrated}
          connecting={connection === "connecting" || connection === "idle"}
          online={online}
          active={active}
          workspaceId={workspaceId}
          projectWorkspaceIds={projectWorkspaceIds}
          knownWorkspaceIds={knownWorkspaceIds}
          wide={!compact && selection.presentation !== "explorer"}
          compact={compact}
          invoke={invoke}
          onRefresh={refresh}
          {...selection}
        />
      </Animated.View>
    </View>
  );
}

type LoadedTasksProps = {
  board: SwarmTaskBoard;
  workspaceId: string;
  projectWorkspaceIds: readonly string[];
  knownWorkspaceIds: readonly string[];
  wide: boolean;
  compact: boolean;
  online: boolean;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
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
  const { t } = useTranslation();
  return (
    <View style={styles.center}>
      <Text style={styles.meta}>{message}</Text>
      {onBack ? (
        <Button variant="ghost" size="sm" onPress={onBack}>
          {t("swarm.tasks.allTasks")}
        </Button>
      ) : null}
    </View>
  );
}

function LoadedTasks({
  board,
  workspaceId,
  projectWorkspaceIds,
  knownWorkspaceIds,
  wide,
  compact,
  online,
  invoke,
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
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(taskId ?? null);
  const [scope, setScope] = useState(initialScope);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    setSelectedTaskId(taskId ?? null);
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
      setSelectedTaskId(null);
      setStatus("");
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
  const filtered = useMemo(() => filterTasks(tasks, status, search), [tasks, status, search]);
  const selected = tasks.find((task) => task.id === selectedTaskId);
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
  const filterStyle = useMemo(() => [styles.filters, wide && styles.filtersWide], [wide]);
  let content: ReactNode;
  if (selected)
    content = (
      <TaskDetail
        key={selected.id}
        task={selected}
        board={board}
        compact={compact}
        showBack
        onBack={back}
        onOpenTask={openTask}
        onOpenReference={onOpenReference}
        invoke={invoke}
        onRefresh={onRefresh}
        online={online}
        knownWorkspaceIds={knownWorkspaceIds}
      />
    );
  else if (selectedTaskId)
    content = <TaskPlaceholder message={t("swarm.tasks.unavailableInScope")} onBack={back} />;
  else if (presentation === "main" && wide)
    content = <TaskKanban tasks={filtered} board={board} status={status} onOpen={openTask} />;
  else
    content = (
      <TaskRows
        tasks={filtered}
        board={board}
        selectedTaskId={selectedTaskId}
        emptyMessage={tasks.length === 0 ? t("swarm.tasks.emptyScope") : t("swarm.tasks.noMatches")}
        onOpen={openTask}
      />
    );
  return (
    <View style={styles.loaded}>
      <View style={filterStyle}>
        <TaskSelect
          label={t("swarm.tasks.scope")}
          value={scope}
          options={scopeOptions}
          onSelect={changeScope}
        />
        {!selectedTaskId ? (
          <>
            <View style={wide ? styles.searchWide : undefined}>
              <FormTextInput
                initialValue={search}
                size={compact ? "md" : "sm"}
                onChangeText={setSearch}
                placeholder={t("swarm.tasks.findTask")}
                accessibilityLabel={t("swarm.tasks.findTask")}
                testID="swarm-task-search"
              />
            </View>
            <TaskSelect
              label={t("swarm.tasks.status")}
              value={status}
              options={statusOptions}
              onSelect={setStatus}
            />
          </>
        ) : null}
      </View>
      {content}
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
  board,
  status,
  onOpen,
}: {
  tasks: readonly SwarmTask[];
  board: SwarmTaskBoard;
  status: string;
  onOpen: (id: string) => void;
}) {
  const { t } = useTranslation();
  const columns = swarmTaskColumns(board, tasks).filter(
    (column) => !status || column.status === status,
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
        <View style={styles.column} key={column.status} testID={`swarm-column-${column.status}`}>
          <View style={styles.columnHeading}>
            <StatusBadge label={column.status} />
            <Text style={styles.meta}>{column.tasks.length}</Text>
          </View>
          <ScrollView contentContainerStyle={styles.columnCards} nestedScrollEnabled>
            {column.tasks.length === 0 ? (
              <Text style={styles.meta}>{t("swarm.tasks.emptyTasks")}</Text>
            ) : (
              column.tasks.map((task) => (
                <SurfaceCard key={task.id}>
                  <TaskRow
                    task={task}
                    selected={false}
                    attention={
                      unansweredChoices(
                        board.activities.filter((activity) => activity.taskId === task.id),
                      ).length
                    }
                    onOpen={onOpen}
                  />
                </SurfaceCard>
              ))
            )}
          </ScrollView>
        </View>
      ))}
    </ScrollView>
  );
}

function filterTasks(tasks: readonly SwarmTask[], status: string, search: string) {
  const text = search.trim().toLowerCase();
  return tasks.filter(
    (task) =>
      (!status || task.status === status) &&
      (!text || `${task.id} ${task.title} ${task.managerName}`.toLowerCase().includes(text)),
  );
}

function TaskRows({
  tasks,
  board,
  selectedTaskId,
  emptyMessage,
  onOpen,
}: {
  tasks: readonly SwarmTask[];
  board: SwarmTaskBoard;
  selectedTaskId: string | null;
  emptyMessage: string;
  onOpen: (id: string) => void;
}) {
  return (
    <ScrollView contentContainerStyle={styles.taskRows}>
      {tasks.length === 0 ? (
        <Text style={styles.meta}>{emptyMessage}</Text>
      ) : (
        tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            selected={selectedTaskId === task.id}
            attention={
              unansweredChoices(board.activities.filter((activity) => activity.taskId === task.id))
                .length
            }
            onOpen={onOpen}
          />
        ))
      )}
    </ScrollView>
  );
}

function TaskRow({
  task,
  selected,
  attention,
  onOpen,
}: {
  task: SwarmTask;
  selected: boolean;
  attention: number;
  onOpen: (id: string) => void;
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
        <StatusBadge label={task.status} />
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

function TaskDetail({
  task,
  board,
  compact,
  showBack,
  onBack,
  onOpenTask,
  onOpenReference,
  invoke,
  onRefresh,
  online,
  knownWorkspaceIds,
}: {
  task: SwarmTask;
  board: SwarmTaskBoard;
  compact: boolean;
  showBack: boolean;
  onBack: () => void;
  onOpenTask: (id: string) => void;
  onOpenReference?: (reference: SwarmTaskReference) => void;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  onRefresh: () => void;
  online: boolean;
  knownWorkspaceIds: readonly string[];
}) {
  const { t } = useTranslation();
  const activities = useMemo(
    () => board.activities.filter((activity) => activity.taskId === task.id),
    [board.activities, task.id],
  );
  const [model] = useState(() => openSwarmReply(task.id, activities));
  const reply = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const editor = useRef<EditingTextInputHandle>(null);
  const [actor, setActor] = useState("");
  const [referenceUnavailable, setReferenceUnavailable] = useState(false);
  useEffect(() => {
    model.applyActivities(activities);
  }, [activities, model]);
  useEffect(() => {
    model.refreshTranslations();
  }, [model, t]);
  useEffect(() => () => model.close(), [model]);
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
      if (!agent) {
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
      const reference = resolveSwarmTaskReference(uri, board, knownWorkspaceIds);
      if (!reference) {
        setReferenceUnavailable(true);
        return false;
      }
      setReferenceUnavailable(false);
      if (reference.kind === "task" && !reference.workspaceId) onOpenTask(reference.taskId);
      else onOpenReference?.(reference);
      return false;
    },
    [board, knownWorkspaceIds, onOpenReference, onOpenTask],
  );
  const send = useCallback(async () => {
    if (!online) return;
    // Read the editing owner once at submission, including the latest committed keystroke.
    model.setBody(editor.current?.getText() ?? model.getState().body);
    const sent = await model.submit(async (input) =>
      swarmHumanActivityReceiptSchema.parse(await invoke("swarm.activity.append_human", input)),
    );
    if (sent) {
      editor.current?.replaceText("");
      onRefresh();
    }
  }, [invoke, model, onRefresh, online]);
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
        <Button variant="ghost" size="xs" disabled={reply.pending} onPress={model.cancelReply}>
          {t("swarm.tasks.cancelReply")}
        </Button>
      ) : null,
    [reply.replyTo, reply.pending, model, t],
  );
  return (
    <View style={styles.detail} testID="swarm-task-detail">
      {referenceUnavailable ? (
        <Text style={styles.error} accessibilityRole="alert">
          {t("swarm.tasks.referenceUnavailable")}
        </Text>
      ) : null}
      <ScrollView contentContainerStyle={styles.detailContent} keyboardShouldPersistTaps="handled">
        {showBack ? (
          <Button variant="ghost" size="sm" onPress={onBack}>
            {t("swarm.tasks.allTasks")}
          </Button>
        ) : null}
        <View style={styles.rowMeta}>
          <Text style={styles.title}>{task.title}</Text>
          <StatusBadge label={task.status} />
        </View>
        <Text style={styles.meta}>{task.id}</Text>
        <MarkdownRenderer text={task.brief} compact onLinkPress={openLink} />
        <View style={styles.participants}>
          <Text style={styles.meta}>{t("swarm.tasks.manager")}</Text>
          <PersonButton name={task.managerName} onOpen={openAgent} />
          <Text style={styles.meta}>{t("swarm.tasks.createdBy")}</Text>
          <PersonButton name={task.createdBy} onOpen={openAgent} />
          {task.workerNames.map((name) => (
            <PersonButton key={name} name={name} onOpen={openAgent} />
          ))}
        </View>
        <SettingsSection title={t("swarm.tasks.activity")} flush trailing={actorFilter}>
          {visible.length === 0 ? (
            <Text style={styles.meta}>{t("swarm.tasks.emptyActivity")}</Text>
          ) : (
            visible.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                canChoose={choices.some((choice) => choice.id === activity.id)}
                selectedOption={reply.replyTo === activity.id ? reply.selectedOption : null}
                onReply={model.replyTo}
                pending={reply.pending}
                onOpenActor={openAgent}
                onLinkPress={openLink}
              />
            ))
          )}
        </SettingsSection>
      </ScrollView>
      <View style={styles.composer}>
        {reply.notificationWarning ? (
          <Text style={styles.meta} accessibilityRole="alert">
            {t("swarm.tasks.notificationFailed", { reason: reply.notificationWarning })}
          </Text>
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
            size={compact ? "md" : "sm"}
            multiline
            onChangeText={model.setBody}
            editable={!reply.pending}
            placeholder={t("swarm.tasks.writeActivity")}
            accessibilityLabel={t("swarm.tasks.activityMessage")}
            style={styles.editor}
            testID="swarm-activity-input"
          />
        </Field>
        <View style={styles.sendRow}>
          {reply.replyTo ? (
            <TaskSelect
              label={t("swarm.tasks.responseProfile")}
              value={reply.responseProfile}
              options={responseProfiles
                .filter((profile) => !profiles || profiles.includes(profile.value))
                .map((profile) => ({ value: profile.value, label: t(profile.labelKey) }))}
              onSelect={setProfile}
              disabled={reply.pending}
            />
          ) : null}
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
  canChoose,
  selectedOption,
  onReply,
  pending,
  onOpenActor,
  onLinkPress,
}: {
  activity: SwarmActivity;
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
  return (
    <View style={styles.activity} testID={`swarm-activity-${activity.id}`}>
      <View style={styles.activityHeader}>
        {activity.actorKind === "agent" ? (
          <PersonButton name={activity.actorName} onOpen={onOpenActor} />
        ) : (
          <Text style={styles.primary}>{activity.actorName}</Text>
        )}
        <Text style={styles.meta}>
          {activity.kind}
          {activity.responseProfile ? ` · ${activity.responseProfile}` : ""}
        </Text>
        <Button
          variant="ghost"
          size="xs"
          disabled={pending}
          onPress={reply}
          accessibilityLabel={t("swarm.tasks.replyAccessibility", { actor: activity.actorName })}
        >
          {t("swarm.tasks.reply")}
        </Button>
      </View>
      <Text style={styles.meta}>
        {new Date(activity.createdAt).toLocaleString()}
        {activity.replyTo ? ` · ${t("swarm.tasks.replyToActivity", { id: activity.replyTo })}` : ""}
      </Text>
      <MarkdownRenderer text={activity.body} compact onLinkPress={onLinkPress} />
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

function PersonButton({ name, onOpen }: { name: string; onOpen: (name: string) => void }) {
  const open = useCallback(() => onOpen(name), [onOpen, name]);
  return (
    <Button variant="ghost" size="xs" onPress={open}>
      {name}
    </Button>
  );
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
  kanban: { flex: 1 },
  columns: { gap: theme.spacing[3], padding: theme.spacing[3] },
  column: { width: 260, gap: theme.spacing[2] },
  columnHeading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: 32,
  },
  columnCards: { gap: theme.spacing[2], paddingBottom: theme.spacing[3] },
  filters: { padding: theme.spacing[3], gap: theme.spacing[2] },
  filtersWide: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" },
  searchWide: { flex: 1, minWidth: 160 },
  taskRows: { padding: theme.spacing[2], gap: theme.spacing[1] },
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
  detailContent: { padding: theme.spacing[4], gap: theme.spacing[2] },
  participants: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[1],
    marginBottom: theme.spacing[2],
  },
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
  choices: { gap: theme.spacing[2], paddingVertical: theme.spacing[2] },
  choice: { alignItems: "flex-start", gap: theme.spacing[1] },
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
