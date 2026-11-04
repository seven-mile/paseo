import { useCallback, useMemo } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { FileText } from "lucide-react-native";
import type { QueryClient } from "@tanstack/react-query";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFetchQuery } from "@/data/query";
import { formatTimeAgo } from "@/utils/time";
import {
  artifactReaders,
  changedSinceLastDelivery,
  swarmArtifactsSchema,
  type DeliveredArtifact,
  type SwarmArtifact,
} from "./artifact-model";
import { SWARM_POLL_MS, selectSwarmValue, swarmConditionalQuery } from "./sync";

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
      <Button
        variant="ghost"
        size="xs"
        leftIcon={FileText}
        onPress={open}
        disabled={!link || !onOpenLink}
        testID={`swarm-artifact-open-${artifact.id}`}
      >
        {artifact.title}
      </Button>
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
  onOpenLink,
  onOpenTask,
}: {
  artifacts: readonly SwarmArtifact[];
  loading: boolean;
  onOpenLink: ((uri: string) => boolean) | null | undefined;
  onOpenTask: (taskId: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <ScrollView contentContainerStyle={styles.rows} testID="swarm-artifact-list">
      {artifacts.length === 0 ? (
        <Text style={styles.meta}>
          {loading ? t("swarm.tasks.loading") : t("swarm.artifacts.empty")}
        </Text>
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
    <View style={styles.rowHost}>
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
        <View style={styles.rowMeta}>
          <Text style={styles.meta} numberOfLines={1}>
            {t("swarm.artifacts.byAuthor", { author: artifact.authorName })}
            {` · ${formatTimeAgo(new Date(artifact.changedAt))}`}
          </Text>
          {changed ? (
            <StatusBadge size="xs" label={t("swarm.artifacts.changedSinceLastDelivery")} />
          ) : null}
        </View>
        <Text style={styles.meta} numberOfLines={1}>
          {readers.length > 0
            ? t("swarm.artifacts.deliveredTo", { names: readers.join(", ") })
            : t("swarm.artifacts.notDelivered")}
        </Text>
      </Pressable>
      {taskId ? (
        <View style={styles.rowMeta}>
          <Button
            variant="ghost"
            size="xs"
            onPress={openTask}
            testID={`swarm-artifact-task-${artifact.id}`}
          >
            {artifact.taskTitle ?? taskId}
          </Button>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  entries: { gap: theme.spacing[1] },
  entry: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: theme.spacing[2] },
  rows: { padding: theme.spacing[2], gap: theme.spacing[1] },
  rowHost: { gap: theme.spacing[1] },
  row: {
    minHeight: 64,
    padding: theme.spacing[2],
    gap: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  pressedRow: { backgroundColor: theme.colors.surface2 },
  rowMeta: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2], flexWrap: "wrap" },
  primary: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
