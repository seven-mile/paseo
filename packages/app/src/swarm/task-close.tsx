import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { FormTextInput } from "@/components/ui/form-field";

// The human closes open Tasks as done without a delivery, with a reason the record keeps. One Task
// tells its owner; a column close is quiet, for clearing Tasks finished before Swarm recorded
// results. Closing records the decision and never stops a running turn.
export function TaskCloseControl({
  tasks,
  owner,
  invoke,
  onClosed,
  testID,
}: {
  // Task ids are unique only within a swarm, so each Task names its swarm.
  tasks: readonly { id: string; swarmId: string }[];
  // The owner told of a single close. Absent for a quiet close of several Tasks.
  owner?: string;
  invoke: <T>(method: string, input: unknown) => Promise<T>;
  onClosed: () => void;
  testID: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const quiet = owner === undefined;
  const start = useCallback(() => setOpen(true), []);
  const cancel = useCallback(() => {
    setOpen(false);
    setReason("");
    setError(null);
  }, []);
  const confirm = useCallback(async () => {
    const text = reason.trim();
    if (!text || pending) return;
    setPending(true);
    setError(null);
    try {
      const bySwarm = new Map<string, string[]>();
      for (const task of tasks) {
        bySwarm.set(task.swarmId, [...(bySwarm.get(task.swarmId) ?? []), task.id]);
      }
      for (const [swarmId, taskIds] of bySwarm) {
        await invoke("swarm.tasks.close", { swarmId, taskIds, reason: text, quiet });
      }
      setOpen(false);
      setReason("");
      onClosed();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }, [invoke, onClosed, pending, quiet, reason, tasks]);
  if (!open) {
    return (
      <Button variant="ghost" size="xs" onPress={start} testID={testID}>
        {quiet ? t("swarm.tasks.closeAllAsDone") : t("swarm.tasks.closeAsDone")}
      </Button>
    );
  }
  return (
    <View style={styles.form} testID={`${testID}-form`}>
      <Text style={styles.meta}>
        {quiet
          ? t("swarm.tasks.closeQuietly", { count: tasks.length })
          : t("swarm.tasks.closeTellsOwner", { owner })}
      </Text>
      <FormTextInput
        initialValue=""
        size="sm"
        onChangeText={setReason}
        placeholder={t("swarm.tasks.closeReason")}
        accessibilityLabel={t("swarm.tasks.closeReason")}
        testID={`${testID}-reason`}
      />
      <View style={styles.actions}>
        <Button variant="ghost" size="sm" onPress={cancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button
          variant="default"
          size="sm"
          onPress={confirm}
          disabled={!reason.trim() || pending}
          testID={`${testID}-confirm`}
        >
          {t("swarm.tasks.closeAsDone")}
        </Button>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  form: { gap: theme.spacing[2] },
  actions: { flexDirection: "row", justifyContent: "flex-end", gap: theme.spacing[2] },
  meta: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
