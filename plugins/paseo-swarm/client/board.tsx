import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
} from "react-native";
import { appendHumanActivityRpc, boardReadRpc } from "../shared/swarm";
import type { Activity, ResponseProfile, SwarmState, Task } from "../shared/models";
import { splitMarkdownParts, type ActivityRef } from "../shared/refs";

const empty: SwarmState = { version: 1, agents: [], tasks: [], activities: [] };

interface ActionOption {
  id: string;
  label: string;
  description?: string;
}
interface ActivityAction {
  type: "choice";
  prompt: string;
  options: ActionOption[];
  responseProfiles?: ResponseProfile[];
}

const responseProfiles: Array<{ id: ResponseProfile; label: string }> = [
  { id: "decision", label: "Hard decision" },
  { id: "steering", label: "Steering" },
  { id: "discussion", label: "Discuss" },
];

function useBoardStyles(theme: PluginSurfaceProps["theme"], compact = false) {
  return useMemo(
    () =>
      StyleSheet.create({
        accentName: { color: theme.colors.accent, fontWeight: "600" },
        mutedActorKind: { color: theme.colors.foregroundMuted, fontWeight: "400" },
        activityBody: { color: theme.colors.foreground, marginTop: 5 },
        refLink: { color: theme.colors.accent, textDecorationLine: "underline" },
        missingRefLink: { color: theme.colors.foregroundMuted, textDecorationLine: "underline" },
        humanActivity: {
          borderLeftWidth: 2,
          borderLeftColor: theme.colors.accent,
          paddingLeft: 10,
          marginBottom: 14,
        },
        agentActivity: {
          borderLeftWidth: 2,
          borderLeftColor: theme.colors.border,
          paddingLeft: 10,
          marginBottom: 14,
        },
        activityHeader: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
        metadata: { color: theme.colors.foregroundMuted, fontSize: 12 },
        replyMetadata: { color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 3 },
        screen: { flex: 1, backgroundColor: theme.colors.surface0 },
        content: { padding: compact ? 12 : 20 },
        back: { color: theme.colors.accent, marginBottom: 12 },
        taskTitle: { color: theme.colors.foreground, fontSize: 22, fontWeight: "700" },
        taskIdentity: { color: theme.colors.foregroundMuted, marginTop: 4 },
        taskBrief: { color: theme.colors.foreground, marginTop: 12 },
        roster: { gap: 5, marginTop: 14, marginBottom: 18 },
        muted: { color: theme.colors.foregroundMuted },
        mutedBelow: { color: theme.colors.foregroundMuted, marginTop: 5 },
        workerRow: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
        clearFilter: { color: theme.colors.accent, marginTop: 5 },
        decisionCard: {
          backgroundColor: theme.colors.surface1,
          padding: 12,
          borderRadius: 8,
          marginBottom: 18,
        },
        strong: { color: theme.colors.foreground, fontWeight: "700" },
        decisionPrompt: { color: theme.colors.foreground, marginTop: 6 },
        choices: { gap: 7, marginTop: 10 },
        selectedChoice: {
          borderWidth: 1,
          borderColor: theme.colors.accent,
          padding: 9,
          borderRadius: 6,
        },
        choice: {
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: 9,
          borderRadius: 6,
        },
        label: { color: theme.colors.foreground, fontWeight: "600" },
        optionDescription: { color: theme.colors.foregroundMuted, marginTop: 3 },
        profileRow: { flexDirection: "row", gap: 8, marginTop: 10 },
        accent: { color: theme.colors.accent },
        activityHeading: {
          color: theme.colors.foreground,
          fontSize: 17,
          fontWeight: "700",
          marginBottom: 12,
        },
        composer: {
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          paddingTop: 14,
          marginTop: 8,
        },
        composerLabel: { color: theme.colors.foregroundMuted, marginBottom: 6 },
        input: {
          minHeight: 72,
          borderWidth: 1,
          borderColor: theme.colors.border,
          color: theme.colors.foreground,
          padding: 10,
          borderRadius: 6,
          textAlignVertical: "top",
        },
        composerActions: { flexDirection: "row", gap: 12, marginTop: 8 },
        disabledSend: { color: theme.colors.foregroundMuted, fontWeight: "700" },
        send: { color: theme.colors.accent, fontWeight: "700" },
        boardHeader: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 12,
          marginBottom: 18,
        },
        intro: { flex: 1, gap: 4 },
        boardTitle: { color: theme.colors.foreground, fontSize: 26, fontWeight: "700" },
        description: { color: theme.colors.foregroundMuted, lineHeight: 19 },
        refresh: {
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 8,
          paddingHorizontal: 11,
          paddingVertical: 8,
        },
        mutedLabel: { color: theme.colors.foregroundMuted, fontWeight: "600" },
        stats: { flexDirection: "row", gap: 8, marginBottom: 24 },
        stat: {
          flex: 1,
          backgroundColor: theme.colors.surface1,
          borderRadius: 9,
          borderWidth: 1,
          borderColor: theme.colors.border,
          padding: 11,
        },
        statValue: { color: theme.colors.foreground, fontSize: 20, fontWeight: "700" },
        agents: { marginBottom: 22 },
        agentHeader: {
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 9,
        },
        heading: { color: theme.colors.foreground, fontSize: 17, fontWeight: "700" },
        agentRow: {
          flexDirection: "row",
          alignItems: "center",
          backgroundColor: theme.colors.surface1,
          borderRadius: 9,
          padding: 10,
          marginBottom: 6,
        },
        plannerDot: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.accent,
          marginRight: 10,
        },
        agentDot: {
          width: 8,
          height: 8,
          borderRadius: 4,
          backgroundColor: theme.colors.foregroundMuted,
          marginRight: 10,
        },
        fill: { flex: 1 },
        role: { color: theme.colors.foregroundMuted, marginTop: 2 },
        tasksHeading: {
          color: theme.colors.foreground,
          fontSize: 17,
          fontWeight: "700",
          marginBottom: 10,
        },
        statusGroup: { marginBottom: 20 },
        statusHeading: {
          color: theme.colors.foreground,
          fontSize: 16,
          fontWeight: "600",
          marginBottom: 8,
        },
        taskCard: {
          backgroundColor: theme.colors.surface1,
          padding: 12,
          marginBottom: 8,
          borderRadius: 8,
        },
      }),
    [theme, compact],
  );
}

function actionFrom(activity: Activity): ActivityAction | null {
  const value = activity.data.action;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = value as Record<string, unknown>;
  if (
    action.type !== "choice" ||
    typeof action.prompt !== "string" ||
    !Array.isArray(action.options)
  ) {
    return null;
  }
  const options = action.options.filter((option): option is ActionOption => {
    if (!option || typeof option !== "object" || Array.isArray(option)) return false;
    const candidate = option as Record<string, unknown>;
    return typeof candidate.id === "string" && typeof candidate.label === "string";
  });
  if (options.length === 0) return null;
  const profiles = Array.isArray(action.responseProfiles)
    ? action.responseProfiles.filter(
        (profile): profile is ResponseProfile =>
          profile === "decision" || profile === "steering" || profile === "discussion",
      )
    : undefined;
  return { type: "choice", prompt: action.prompt, options, responseProfiles: profiles };
}

function Person({
  name,
  kind,
  onPress,
  theme,
}: {
  name: string;
  kind: "agent" | "human";
  onPress?: () => void;
  theme: PluginSurfaceProps["theme"];
}) {
  const styles = useBoardStyles(theme);
  const content = (
    <Text style={styles.accentName}>
      {name} <Text style={styles.mutedActorKind}>({kind})</Text>
    </Text>
  );
  return onPress ? <Pressable onPress={onPress}>{content}</Pressable> : content;
}

function ValuePressable<T>({
  value,
  onValuePress,
  ...props
}: Omit<PressableProps, "onPress"> & { value: T; onValuePress: (value: T) => void }) {
  const onPress = useCallback(() => onValuePress(value), [onValuePress, value]);
  return <Pressable {...props} onPress={onPress} />;
}

function AgentPerson({
  name,
  theme,
  onNamePress,
}: {
  name: string;
  theme: PluginSurfaceProps["theme"];
  onNamePress: (name: string) => void;
}) {
  const onPress = useCallback(() => onNamePress(name), [name, onNamePress]);
  return <Person name={name} kind="agent" theme={theme} onPress={onPress} />;
}

function ReferenceText({
  label,
  target,
  theme,
  onRefPress,
}: {
  label: string;
  target: ActivityRef | undefined;
  theme: PluginSurfaceProps["theme"];
  onRefPress: (ref: ActivityRef) => void;
}) {
  const styles = useBoardStyles(theme);
  const onPress = useCallback(() => {
    if (target) onRefPress(target);
  }, [target, onRefPress]);
  return (
    <Text
      onPress={target ? onPress : undefined}
      style={target ? styles.refLink : styles.missingRefLink}
    >
      {label}
    </Text>
  );
}

function ActivityBody({
  activity,
  theme,
  onRefPress,
}: {
  activity: Activity;
  theme: PluginSurfaceProps["theme"];
  onRefPress: (ref: ActivityRef) => void;
}) {
  const styles = useBoardStyles(theme);
  const refs = new Map(activity.refs.map((ref) => [ref.uri, ref]));
  const parts = useMemo(() => {
    const occurrences = new Map<string, number>();
    return splitMarkdownParts(activity.body).map((part) => {
      const content = part.kind === "text" ? part.text : `${part.uri}:${part.label}`;
      const identity = `${part.kind}:${content}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      return { part, key: `${identity}:${occurrence}` };
    });
  }, [activity.body]);
  return (
    <Text style={styles.activityBody}>
      {parts.map(({ part, key }) =>
        part.kind === "text" ? (
          <Text key={key}>{part.text}</Text>
        ) : (
          <ReferenceText
            key={key}
            label={part.label}
            target={refs.get(part.uri)}
            theme={theme}
            onRefPress={onRefPress}
          />
        ),
      )}
    </Text>
  );
}

function ActivityRow({
  activity,
  theme,
  onActorPress,
  onRefPress,
}: {
  activity: Activity;
  theme: PluginSurfaceProps["theme"];
  onActorPress: (name: string) => void;
  onRefPress: (ref: ActivityRef) => void;
}) {
  const styles = useBoardStyles(theme);
  const pressActor = useCallback(
    () => onActorPress(activity.actorName),
    [activity.actorName, onActorPress],
  );
  return (
    <View style={activity.actorKind === "human" ? styles.humanActivity : styles.agentActivity}>
      <View style={styles.activityHeader}>
        <Person
          name={activity.actorName}
          kind={activity.actorKind}
          onPress={pressActor}
          theme={theme}
        />
        <Text style={styles.metadata}>{activity.kind}</Text>
      </View>
      {activity.replyTo ? (
        <Text style={styles.replyMetadata}>
          Reply to {activity.replyTo}
          {activity.responseProfile ? ` · ${activity.responseProfile}` : ""}
        </Text>
      ) : null}
      <ActivityBody activity={activity} theme={theme} onRefPress={onRefPress} />
    </View>
  );
}

function findAgent(board: SwarmState, reference: string) {
  return board.agents.find(
    (agent) =>
      agent.qualifiedName === reference ||
      agent.name === reference ||
      agent.aliases.includes(reference),
  );
}

function TaskDetail({
  task,
  board,
  theme,
  layout,
  navigation,
  hostId,
  onBack,
  onRefresh,
  onTaskPress,
}: {
  task: Task;
  board: SwarmState;
  theme: PluginSurfaceProps["theme"];
  layout: PluginSurfaceProps["layout"];
  navigation: PluginSurfaceProps["navigation"];
  hostId: string;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onTaskPress: (taskId: string) => void;
}) {
  const styles = useBoardStyles(theme, layout.compact);
  const appendHumanActivity = useRpc(appendHumanActivityRpc);
  const [actorFilter, setActorFilter] = useState<string | null>(null);
  const [replyTarget, setReplyTarget] = useState<Activity | null>(null);
  const [selectedOption, setSelectedOption] = useState<string | null>(null);
  const [responseProfile, setResponseProfile] = useState<ResponseProfile>("decision");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const allActivities = board.activities.filter((activity) => activity.taskId === task.id);
  const activities = useMemo(
    () => allActivities.filter((activity) => !actorFilter || activity.actorName === actorFilter),
    [actorFilter, allActivities],
  );
  const visibleAction = allActivities
    .map((activity) => ({ activity, action: actionFrom(activity) }))
    .find(
      (item): item is { activity: Activity; action: ActivityAction } =>
        item.action !== null && !allActivities.some((reply) => reply.replyTo === item.activity.id),
    );

  const openAgent = useCallback(
    (reference: string): void => {
      const agent = findAgent(board, reference);
      if (agent && navigation) {
        navigation.openAgent({ agentId: agent.paseoAgentId, serverId: hostId });
        return;
      }
      setActorFilter(reference);
    },
    [board, navigation, hostId],
  );

  const openRef = useCallback(
    (ref: ActivityRef): void => {
      if (ref.kind === "agent") {
        if (navigation) navigation.openAgent({ agentId: ref.paseoAgentId, serverId: hostId });
        else setActorFilter(ref.qualifiedName);
        return;
      }
      if (ref.kind === "workspace" || ref.kind === "file") {
        navigation?.openWorkspace({ workspaceId: ref.workspaceId, serverId: hostId });
        return;
      }
      if (ref.kind === "task") onTaskPress(ref.taskId);
    },
    [navigation, hostId, onTaskPress],
  );

  const submitActivity = useCallback(async (): Promise<void> => {
    const selectedLabel = visibleAction?.action.options.find(
      (option) => option.id === selectedOption,
    )?.label;
    const trimmedBody = body.trim();
    if (!replyTarget && !trimmedBody) return;
    if (replyTarget && !selectedLabel && !trimmedBody) return;
    setSubmitting(true);
    try {
      await appendHumanActivity({
        taskId: task.id,
        actorName: "human",
        kind: replyTarget ? "human-response" : "human-note",
        body: [selectedLabel ? `Selected: ${selectedLabel}` : "", trimmedBody]
          .filter(Boolean)
          .join("\n"),
        replyTo: replyTarget?.id ?? null,
        responseProfile: replyTarget ? responseProfile : null,
        data: selectedOption ? { selectedOption } : {},
      });
      setBody("");
      setReplyTarget(null);
      setSelectedOption(null);
      await onRefresh();
    } finally {
      setSubmitting(false);
    }
  }, [
    visibleAction,
    selectedOption,
    body,
    replyTarget,
    appendHumanActivity,
    task.id,
    responseProfile,
    onRefresh,
  ]);

  const clearActorFilter = useCallback((): void => {
    setActorFilter(null);
  }, []);
  const chooseOption = useCallback(
    (optionId: string): void => {
      if (visibleAction) setReplyTarget(visibleAction.activity);
      setSelectedOption(optionId);
    },
    [visibleAction],
  );
  const sendActivity = useCallback((): void => {
    void submitActivity();
  }, [submitActivity]);
  const cancelReply = useCallback((): void => {
    setReplyTarget(null);
    setSelectedOption(null);
  }, []);

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Pressable onPress={onBack}>
        <Text style={styles.back}>← All Tasks</Text>
      </Pressable>
      <Text style={styles.taskTitle}>{task.title}</Text>
      <Text style={styles.taskIdentity}>
        {task.id} · {task.status}
      </Text>
      <Text style={styles.taskBrief}>{task.brief}</Text>
      <View style={styles.roster}>
        <Text style={styles.muted}>Created by</Text>
        <AgentPerson name={task.createdBy} onNamePress={openAgent} theme={theme} />
        <Text style={styles.muted}>Manager</Text>
        <AgentPerson name={task.managerName} onNamePress={openAgent} theme={theme} />
        <Text style={styles.mutedBelow}>Workers</Text>
        <View style={styles.workerRow}>
          {task.workerNames.length === 0 ? (
            <Text style={styles.muted}>Unassigned</Text>
          ) : (
            task.workerNames.map((name) => (
              <AgentPerson key={name} name={name} onNamePress={openAgent} theme={theme} />
            ))
          )}
        </View>
        {actorFilter ? (
          <Pressable onPress={clearActorFilter}>
            <Text style={styles.clearFilter}>Show all Activity</Text>
          </Pressable>
        ) : null}
      </View>

      {visibleAction ? (
        <View style={styles.decisionCard}>
          <Text style={styles.strong}>Decision needed</Text>
          <Text style={styles.decisionPrompt}>{visibleAction.action.prompt}</Text>
          <View style={styles.choices}>
            {visibleAction.action.options.map((option) => (
              <ValuePressable
                key={option.id}
                value={option.id}
                onValuePress={chooseOption}
                style={selectedOption === option.id ? styles.selectedChoice : styles.choice}
              >
                <Text style={styles.label}>{option.label}</Text>
                {option.description ? (
                  <Text style={styles.optionDescription}>{option.description}</Text>
                ) : null}
              </ValuePressable>
            ))}
          </View>
          <View style={styles.profileRow}>
            {(
              visibleAction.action.responseProfiles ?? responseProfiles.map((profile) => profile.id)
            ).map((profile) => {
              const item = responseProfiles.find((candidate) => candidate.id === profile);
              if (!item) return null;
              return (
                <ValuePressable key={item.id} value={item.id} onValuePress={setResponseProfile}>
                  <Text style={responseProfile === item.id ? styles.accent : styles.muted}>
                    {item.label}
                  </Text>
                </ValuePressable>
              );
            })}
          </View>
        </View>
      ) : null}

      <Text style={styles.activityHeading}>Activity</Text>
      {activities.length === 0 ? (
        <Text style={styles.muted}>No Activity yet.</Text>
      ) : (
        activities.map((activity) => (
          <ActivityRow
            key={activity.id}
            activity={activity}
            theme={theme}
            onActorPress={openAgent}
            onRefPress={openRef}
          />
        ))
      )}

      <View style={styles.composer}>
        <Text style={styles.composerLabel}>
          {replyTarget ? `Replying to ${replyTarget.id}` : "Add human Activity"}
        </Text>
        <TextInput
          multiline
          value={body}
          onChangeText={setBody}
          placeholder={
            replyTarget
              ? "Add context or reasoning (optional with a choice)"
              : "Write a note for the Task manager"
          }
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
        />
        <View style={styles.composerActions}>
          <Pressable disabled={submitting} onPress={sendActivity}>
            <Text style={submitting ? styles.disabledSend : styles.send}>
              {submitting ? "Sending…" : "Send Activity"}
            </Text>
          </Pressable>
          {replyTarget ? (
            <Pressable onPress={cancelReply}>
              <Text style={styles.muted}>Cancel reply</Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    </ScrollView>
  );
}

export function BoardSurface({ theme, layout, navigation, host }: PluginSurfaceProps) {
  const styles = useBoardStyles(theme, layout.compact);
  const readBoard = useRpc(boardReadRpc);
  const [board, setBoard] = useState<SwarmState>(empty);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setBoard(await readBoard({}));
  }, [readBoard]);

  useEffect(() => {
    let active = true;
    void readBoard({}).then((value) => {
      if (active) setBoard(value);
      return;
    });
    return () => {
      active = false;
    };
  }, [readBoard]);

  const back = useCallback((): void => {
    setSelectedTaskId(null);
  }, []);
  const requestRefresh = useCallback((): void => {
    void refresh();
  }, [refresh]);
  const openBoardAgent = useCallback(
    (agentId: string): void => {
      navigation?.openAgent({ agentId, serverId: host.id });
    },
    [navigation, host.id],
  );

  const selectedTask = selectedTaskId
    ? board.tasks.find((task) => task.id === selectedTaskId)
    : null;
  if (selectedTask) {
    return (
      <TaskDetail
        task={selectedTask}
        board={board}
        theme={theme}
        layout={layout}
        navigation={navigation}
        hostId={host.id}
        onBack={back}
        onRefresh={refresh}
        onTaskPress={setSelectedTaskId}
      />
    );
  }

  const statuses = [...new Set(board.tasks.map((task) => task.status))];
  const activeAgents = board.agents.filter((agent) => !agent.retired);
  const attentionCount = board.activities.filter(
    (activity) => activity.actorKind === "human",
  ).length;
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.boardHeader}>
        <View style={styles.intro}>
          <Text style={styles.boardTitle}>Swarm</Text>
          <Text style={styles.description}>
            Coordinate planners, agents, Tasks, and human decisions from one place.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh Swarm"
          onPress={requestRefresh}
          style={styles.refresh}
        >
          <Text style={styles.mutedLabel}>Refresh</Text>
        </Pressable>
      </View>
      <View style={styles.stats}>
        {[
          { label: "Agents", value: activeAgents.length },
          { label: "Tasks", value: board.tasks.length },
          { label: "Human notes", value: attentionCount },
        ].map((item) => (
          <View key={item.label} style={styles.stat}>
            <Text style={styles.statValue}>{item.value}</Text>
            <Text style={styles.replyMetadata}>{item.label}</Text>
          </View>
        ))}
      </View>
      <View style={styles.agents}>
        <View style={styles.agentHeader}>
          <Text style={styles.heading}>Agents</Text>
          <Text style={styles.metadata}>
            {board.agents.filter((agent) => !agent.retired).length}
          </Text>
        </View>
        {activeAgents.length === 0 ? (
          <Text style={styles.muted}>Create a planner to start a Swarm workspace.</Text>
        ) : (
          activeAgents.map((agent) => (
            <ValuePressable
              key={agent.paseoAgentId}
              value={agent.paseoAgentId}
              onValuePress={openBoardAgent}
              style={styles.agentRow}
            >
              <View style={agent.roleClass === "planner" ? styles.plannerDot : styles.agentDot} />
              <View style={styles.fill}>
                <Text style={styles.label}>{agent.qualifiedName ?? agent.name}</Text>
                <Text style={styles.role}>
                  {agent.roleClass}
                  {agent.role ? ` · ${agent.role}` : ""}
                </Text>
              </View>
              <Text style={styles.muted}>›</Text>
            </ValuePressable>
          ))
        )}
      </View>
      <Text style={styles.tasksHeading}>Tasks</Text>
      {statuses.length === 0 ? (
        <Text style={styles.muted}>No Tasks yet.</Text>
      ) : (
        statuses.map((status) => (
          <View key={status} style={styles.statusGroup}>
            <Text style={styles.statusHeading}>{status}</Text>
            {board.tasks
              .filter((task) => task.status === status)
              .map((task) => (
                <ValuePressable
                  key={task.id}
                  value={task.id}
                  onValuePress={setSelectedTaskId}
                  style={styles.taskCard}
                >
                  <Text style={styles.label}>{task.title}</Text>
                  <Text style={styles.taskIdentity}>
                    {task.id} · {task.managerName} · {task.workerNames.join(", ") || "unassigned"}
                  </Text>
                  <Text style={styles.mutedBelow}>
                    {board.activities.filter((activity) => activity.taskId === task.id).length}{" "}
                    activities
                  </Text>
                </ValuePressable>
              ))}
          </View>
        ))
      )}
    </ScrollView>
  );
}
