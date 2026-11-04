import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react-native";
import type { QueryClient } from "@tanstack/react-query";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatTimeAgo } from "@/utils/time";
import {
  artifactReaders,
  changedSinceLastDelivery,
  swarmArtifactsSchema,
  type DeliveredArtifact,
  type SwarmArtifact,
} from "./artifact-model";
import { SwarmInlineLink } from "./inline-link";
import { SWARM_POLL_MS, selectSwarmValue, swarmConditionalQuery } from "./sync";

const ThemedFileText = withUnistyles(FileText);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ARTIFACT_ICON = <ThemedFileText size={ICON_SIZE.sm} uniProps={mutedIcon} />;

interface SwarmArtifacts {
  artifacts: SwarmArtifact[];
}
const NO_ARTIFACTS: SwarmArtifact[] = [];

// A project's artifacts, most recently changed first.
export function useSwarmArtifacts(input: {
  serverId: string;
  projectId: string | null;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  queryClient: QueryClient | undefined;
  enabled: boolean;
}) {
  const { serverId, projectId, invoke, queryClient } = input;
  const queryKey = useMemo(
    () => ["swarm", "artifacts", serverId, projectId],
    [serverId, projectId],
  );
  const query = useFetchQuery(
    {
      queryKey,
      queryFn: swarmConditionalQuery({
        queryClient,
        queryKey,
        schema: swarmArtifactsSchema,
        read: (etag) =>
          invoke("swarm.artifacts.read", {
            projectId: projectId ?? undefined,
            ...(etag ? { etag } : {}),
          }),
      }),
      select: selectSwarmValue<SwarmArtifacts>,
      enabled: input.enabled && Boolean(projectId),
      refetchInterval: SWARM_POLL_MS,
      dataShape: "value",
      staleTimeMs: SWARM_POLL_MS - 500,
    },
    queryClient,
  );
  return {
    artifacts: query.data?.artifacts ?? NO_ARTIFACTS,
    loading: input.enabled && query.isPending,
  };
}

// The artifacts a delivery carried, each opening its copy. "Changed since this delivery" means
// the author edited it after this reader got it; it is a marker, not a notice.
export function DeliveredArtifacts({
  artifacts,
  onOpenLink,
  testID,
}: {
  artifacts: readonly DeliveredArtifact[] | undefined;
  onOpenLink: ((uri: string) => boolean) | null | undefined;
  testID: string;
}) {
  if (!artifacts?.length) return null;
  return (
    <View style={styles.entries} testID={testID}>
      {artifacts.map((artifact) => (
        <DeliveredArtifactEntry key={artifact.id} artifact={artifact} onOpenLink={onOpenLink} />
      ))}
    </View>
  );
}

function DeliveredArtifactEntry({
  artifact,
  onOpenLink,
}: {
  artifact: DeliveredArtifact;
  onOpenLink: ((uri: string) => boolean) | null | undefined;
}) {
  const { t } = useTranslation();
  const link = artifact.location?.link;
  const open = useCallback(() => {
    if (link) onOpenLink?.(link);
  }, [link, onOpenLink]);
  return (
    <View style={styles.entry}>
      <SwarmInlineLink
        label={artifact.title}
        onPress={open}
        disabled={!link || !onOpenLink}
        leading={ARTIFACT_ICON}
        testID={`swarm-artifact-open-${artifact.id}`}
      />
      {artifact.changed ? (
        <StatusBadge size="xs" label={t("swarm.artifacts.changedSinceDelivery")} />
      ) : null}
    </View>
  );
}

// The Artifacts view: every artifact in the project, with who it reached and whether it changed
// since. An artifact here may not have been delivered yet.
export function SwarmArtifactList({
  artifacts,
  loading,
  searching,
  onOpenLink,
  onOpenTask,
}: {
  artifacts: readonly SwarmArtifact[];
  loading: boolean;
  // A search is narrowing the list, so an empty one means no match rather than none at all.
  searching: boolean;
  onOpenLink: ((uri: string) => boolean) | null | undefined;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  let emptyMessage = t("swarm.artifacts.empty");
  if (loading) emptyMessage = t("swarm.tasks.loading");
  else if (searching) emptyMessage = t("swarm.artifacts.noMatches");
  return (
    <ScrollView contentContainerStyle={styles.rows} testID="swarm-artifact-list">
      {artifacts.length === 0 ? (
        <Text style={styles.meta}>{emptyMessage}</Text>
      ) : (
        artifacts.map((artifact) => (
          <ArtifactRow
            key={artifact.id}
            artifact={artifact}
            onOpenLink={onOpenLink}
            onOpenTask={onOpenTask}
          />
        ))
      )}
    </ScrollView>
  );
}

function ArtifactRow({
  artifact,
  onOpenLink,
  onOpenTask,
}: {
  artifact: SwarmArtifact;
  onOpenLink: ((uri: string) => boolean) | null | undefined;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  const link = artifact.location?.link;
  const open = useCallback(() => {
    if (link) onOpenLink?.(link);
  }, [link, onOpenLink]);
  const { taskId } = artifact;
  const openTask = useCallback(() => {
    if (taskId) onOpenTask(taskId);
  }, [onOpenTask, taskId]);
  const rowStyle = useCallback(
    ({ pressed }: { pressed: boolean }) => [styles.row, pressed && styles.pressedRow],
    [],
  );
  const readers = artifactReaders(artifact);
  const changed = changedSinceLastDelivery(artifact);
  return (
    <Pressable
      onPress={open}
      disabled={!link || !onOpenLink}
      style={rowStyle}
      accessibilityRole="button"
      accessibilityLabel={artifact.title}
      testID={`swarm-artifact-${artifact.id}`}
    >
      <Text style={styles.primary} numberOfLines={2}>
        {artifact.title}
      </Text>
      <View style={styles.metaLine}>
        <Text style={styles.meta} numberOfLines={1}>
          {t("swarm.artifacts.byAuthor", { author: artifact.authorName })}
          {` · ${formatTimeAgo(new Date(artifact.changedAt))}`}
          {taskId ? " ·" : ""}
        </Text>
        {taskId ? (
          <SwarmInlineLink
            label={artifact.taskTitle ?? taskId}
            onPress={openTask}
            testID={`swarm-artifact-task-${artifact.id}`}
          />
        ) : null}
      </View>
      <View style={styles.rowMeta}>
        <Text style={styles.meta} numberOfLines={1}>
          {readers.length > 0
            ? t("swarm.artifacts.deliveredTo", { names: readers.join(", ") })
            : t("swarm.artifacts.notDelivered")}
        </Text>
        {changed ? (
          <StatusBadge size="xs" label={t("swarm.artifacts.changedSinceLastDelivery")} />
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  entries: { gap: theme.spacing[2], paddingTop: theme.spacing[1] },
  entry: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  rows: { padding: theme.spacing[2], gap: theme.spacing[1] },
  row: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.lg,
  },
  pressedRow: { backgroundColor: theme.colors.surface2 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  // A link continues the sentence before it, a space apart.
  metaLine: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexWrap: "wrap" },
  primary: { color: theme.colors.foreground, fontSize: theme.fontSize.base, flexShrink: 1 },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
