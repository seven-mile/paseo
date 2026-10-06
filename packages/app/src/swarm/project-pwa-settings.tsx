import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { skipToken, useQueryClient } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { useSwarmRpc } from "./rpc";
import {
  openPwaForm,
  pwaSourceSchema,
  savedPwaSourceSchema,
  type PwaFormSnapshot,
} from "./pwa-form-model";

interface ProjectPwaSettingsProps {
  serverId: string;
  projectId: string;
}

export function ProjectPwaSettings({ serverId, projectId }: ProjectPwaSettingsProps) {
  const { plugin, invoke } = useSwarmRpc(serverId);
  const queryClient = useQueryClient();
  const [session, setSession] = useState<PwaFormSnapshot | null>(null);
  const queryKey = useMemo(
    () => ["swarm", "pwa-source", serverId, projectId],
    [serverId, projectId],
  );
  const query = useFetchQuery({
    queryKey,
    queryFn: plugin
      ? async () => pwaSourceSchema.parse(await invoke("swarm.pwa_source.read", { projectId }))
      : skipToken,
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
  });
  const { data, refetch } = query;
  const retry = useCallback(() => void refetch(), [refetch]);
  const open = useCallback(() => {
    if (!data) return;
    setSession({
      path: data.path,
      async save(path) {
        const saved = savedPwaSourceSchema.parse(
          await invoke("swarm.pwa_source.set", { projectId, path }),
        );
        await queryClient.cancelQueries({ queryKey, exact: true });
        queryClient.setQueryData(queryKey, saved);
        void queryClient.invalidateQueries({
          queryKey: ["swarm", "creation-target", serverId, projectId],
        });
        return saved;
      },
    });
  }, [invoke, projectId, data, queryClient, queryKey, serverId]);
  const close = useCallback(() => {
    setSession(null);
  }, []);
  if (!plugin) return null;
  let content;
  if (query.isError) {
    content = (
      <SettingsRow label="PWA directory" error={query.error.message}>
        <Button variant="outline" size="sm" onPress={retry}>
          Retry
        </Button>
      </SettingsRow>
    );
  } else if (!query.data) {
    content = (
      <SettingsRow label="PWA directory" hint="Loading...">
        <Button variant="outline" size="sm" disabled>
          Edit
        </Button>
      </SettingsRow>
    );
  } else {
    content = (
      <SettingsRow label="PWA directory" hint={query.data.path ?? "Not configured"}>
        <Button variant="outline" size="sm" onPress={open} testID="project-pwa-edit">
          Edit
        </Button>
      </SettingsRow>
    );
  }
  return (
    <SettingsSection title="Swarm" testID="project-pwa-settings">
      <SettingsCard>{content}</SettingsCard>
      {session ? <PwaFormSheet snapshot={session} onClose={close} /> : null}
    </SettingsSection>
  );
}

function usePwaForm(snapshot: PwaFormSnapshot) {
  const [form] = useState(() => openPwaForm(snapshot));
  useEffect(() => () => form.close(), [form]);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  return { form, state };
}

function PwaFormSheet({ snapshot, onClose }: { snapshot: PwaFormSnapshot; onClose(): void }) {
  const { form, state } = usePwaForm(snapshot);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const pending = state.status.kind === "pending";
  const error = state.status.kind === "error" ? state.status.message : null;
  const close = useCallback(() => {
    if (!pending) onClose();
  }, [onClose, pending]);
  const submit = useCallback(() => void form.submit(), [form]);
  const header = useMemo(() => ({ title: "PWA directory" }), []);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={close} disabled={pending}>
          Close
        </Button>
        <Button
          variant="default"
          onPress={submit}
          disabled={!state.canSubmit}
          loading={pending}
          testID="project-pwa-save"
        >
          {pending ? "Saving..." : "Save"}
        </Button>
      </View>
    ),
    [close, pending, state.canSubmit, submit],
  );
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={close}
      footer={footer}
      desktopMaxWidth={440}
      sizeContentToCurrentSnapPoint
      testID="project-pwa-sheet"
    >
      <Field label="Directory" error={error} testID="project-pwa-directory-field">
        <FormTextInput
          key={state.inputRevision}
          initialValue={state.path}
          onChangeText={form.setPath}
          size={size}
          editable={!pending}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="PWA directory"
          testID="project-pwa-directory"
        />
      </Field>
      {state.status.kind === "success" ? (
        <Alert variant="success" title="PWA directory saved" testID="project-pwa-saved" />
      ) : null}
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
