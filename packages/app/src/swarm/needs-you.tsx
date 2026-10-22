import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useIsCompactFormFactor } from "@/constants/layout";
import {
  findSwarmTaskAgent,
  type SwarmInboxItem,
  type SwarmTaskBoard,
  type SwarmTaskReference,
} from "./task-model";

type Invoke = <T>(method: string, input: unknown) => Promise<T>;

const kindVariants = {
  approval: "error",
  permission: "warning",
  choice: "warning",
  error: "error",
} as const;

// Everything in scope that waits on a human, answerable without opening the Task.
export function NeedsYouInbox({
  items,
  board,
  online,
  invoke,
  onRefresh,
  onOpenTask,
  onOpenReference,
}: {
  items: readonly SwarmInboxItem[];
  board: SwarmTaskBoard;
  online: boolean;
  invoke: Invoke;
  onRefresh: () => void;
  onOpenTask: (id: string) => void;
  onOpenReference?: (reference: SwarmTaskReference) => void;
}) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <View style={styles.inbox} testID="swarm-needs-you">
      <View style={styles.heading}>
        <Text style={styles.title}>{t("swarm.inbox.title")}</Text>
        <StatusBadge variant="warning" label={String(items.length)} />
      </View>
      <ScrollView
        style={styles.list}
        contentContainerStyle={styles.listContent}
        nestedScrollEnabled
      >
        {items.map((item) => (
          <InboxRow
            key={item.id}
            item={item}
            board={board}
            online={online}
            invoke={invoke}
            onRefresh={onRefresh}
            onOpenTask={onOpenTask}
            onOpenReference={onOpenReference}
          />
        ))}
      </ScrollView>
    </View>
  );
}

function InboxRow({
  item,
  board,
  online,
  invoke,
  onRefresh,
  onOpenTask,
  onOpenReference,
}: {
  item: SwarmInboxItem;
  board: SwarmTaskBoard;
  online: boolean;
  invoke: Invoke;
  onRefresh: () => void;
  onOpenTask: (id: string) => void;
  onOpenReference?: (reference: SwarmTaskReference) => void;
}) {
  const { t } = useTranslation();
  const compact = useIsCompactFormFactor();
  const size = compact ? "md" : "sm";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = useCallback(
    async (method: string, input: unknown) => {
      setPending(true);
      setError(null);
      try {
        await invoke(method, input);
        onRefresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setPending(false);
      }
    },
    [invoke, onRefresh],
  );
  const open = useCallback(() => {
    if (item.taskId) {
      onOpenTask(item.taskId);
      return;
    }
    const agent = item.agentName ? findSwarmTaskAgent(board.agents, item.agentName) : undefined;
    if (!agent) return;
    onOpenReference?.({
      kind: "agent",
      paseoAgentId: agent.paseoAgentId,
      qualifiedName: agent.qualifiedName ?? agent.name,
      workspaceId: agent.workspaceId,
    });
  }, [board.agents, item, onOpenReference, onOpenTask]);
  const disabled = pending || !online;
  return (
    <View style={styles.row} testID={`swarm-inbox-${item.id}`}>
      <View style={styles.rowHeading}>
        <StatusBadge
          variant={kindVariants[item.kind]}
          label={t(`swarm.inbox.kinds.${item.kind}`)}
        />
        <Text style={styles.primary} numberOfLines={2}>
          {item.title}
        </Text>
      </View>
      <Text style={styles.meta} numberOfLines={1}>
        {[item.agentName, item.taskId, new Date(item.createdAt).toLocaleString()]
          .filter(Boolean)
          .join(" · ")}
      </Text>
      {item.kind === "approval" ? (
        <Text style={styles.code} selectable>
          {item.command}
        </Text>
      ) : null}
      {(item.kind === "permission" || item.kind === "error") && item.detail ? (
        <Text style={styles.meta} numberOfLines={3}>
          {item.detail}
        </Text>
      ) : null}
      {item.kind === "choice" && item.deadline && item.defaultOptionId ? (
        <Text style={styles.meta}>
          {t("swarm.inbox.defaultsAt", {
            option:
              item.options.find((option) => option.id === item.defaultOptionId)?.label ??
              item.defaultOptionId,
            time: new Date(item.deadline).toLocaleString(),
          })}
        </Text>
      ) : null}
      <View style={styles.actions}>
        {item.kind === "approval" ? (
          <>
            <ApprovalButton
              item={item}
              behavior="allow"
              size={size}
              disabled={disabled}
              act={act}
            />
            <ApprovalButton item={item} behavior="deny" size={size} disabled={disabled} act={act} />
          </>
        ) : null}
        {item.kind === "permission" ? (
          <>
            <PermissionButton
              item={item}
              behavior="allow"
              size={size}
              disabled={disabled}
              act={act}
            />
            <PermissionButton
              item={item}
              behavior="deny"
              size={size}
              disabled={disabled}
              act={act}
            />
          </>
        ) : null}
        {item.kind === "choice"
          ? item.options.map((option) => (
              <ChoiceButton
                key={option.id}
                item={item}
                option={option}
                size={size}
                disabled={disabled}
                act={act}
              />
            ))
          : null}
        <Button size={size} variant="ghost" onPress={open}>
          {item.taskId ? t("swarm.inbox.openTask") : t("swarm.inbox.openAgent")}
        </Button>
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

type Act = (method: string, input: unknown) => Promise<void>;
type ButtonSize = "sm" | "md";

function ApprovalButton({
  item,
  behavior,
  size,
  disabled,
  act,
}: {
  item: Extract<SwarmInboxItem, { kind: "approval" }>;
  behavior: "allow" | "deny";
  size: ButtonSize;
  disabled: boolean;
  act: Act;
}) {
  const { t } = useTranslation();
  const press = useCallback(
    () => act("swarm.approval.resolve", { approvalId: item.approvalId, behavior }),
    [act, item.approvalId, behavior],
  );
  return (
    <Button
      size={size}
      variant={behavior === "allow" ? "default" : "outline"}
      disabled={disabled}
      onPress={press}
      testID={`swarm-inbox-${behavior}-${item.id}`}
    >
      {behavior === "allow" ? t("swarm.inbox.approve") : t("swarm.inbox.deny")}
    </Button>
  );
}

function PermissionButton({
  item,
  behavior,
  size,
  disabled,
  act,
}: {
  item: Extract<SwarmInboxItem, { kind: "permission" }>;
  behavior: "allow" | "deny";
  size: ButtonSize;
  disabled: boolean;
  act: Act;
}) {
  const { t } = useTranslation();
  const press = useCallback(
    () =>
      act("swarm.permission.respond", {
        paseoAgentId: item.paseoAgentId,
        permissionId: item.permissionId,
        behavior,
      }),
    [act, item.paseoAgentId, item.permissionId, behavior],
  );
  return (
    <Button
      size={size}
      variant={behavior === "allow" ? "default" : "outline"}
      disabled={disabled || !item.paseoAgentId}
      onPress={press}
    >
      {behavior === "allow" ? t("swarm.inbox.allow") : t("swarm.inbox.deny")}
    </Button>
  );
}

function ChoiceButton({
  item,
  option,
  size,
  disabled,
  act,
}: {
  item: Extract<SwarmInboxItem, { kind: "choice" }>;
  option: { id: string; label: string };
  size: ButtonSize;
  disabled: boolean;
  act: Act;
}) {
  const press = useCallback(
    () =>
      act("swarm.activity.append_human", {
        taskId: item.taskId,
        actorName: "human",
        kind: "human-response",
        body: `Selected: ${option.label}`,
        replyTo: item.activityId,
        responseProfile: item.responseProfiles?.[0] ?? "decision",
        data: { selectedOption: option.id },
      }),
    [act, item.taskId, item.activityId, item.responseProfiles, option.id, option.label],
  );
  return (
    <Button
      size={size}
      variant={option.id === item.defaultOptionId ? "secondary" : "outline"}
      disabled={disabled || !item.taskId}
      onPress={press}
      testID={`swarm-inbox-option-${item.id}-${option.id}`}
    >
      {option.label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  inbox: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  list: { maxHeight: 320 },
  listContent: { padding: theme.spacing[2], gap: theme.spacing[1] },
  row: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
  },
  rowHeading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  primary: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingTop: theme.spacing[1],
  },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
