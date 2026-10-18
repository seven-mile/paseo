import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { skipToken, useQueryClient } from "@tanstack/react-query";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { SettingsCard, SettingsRow, SettingsSection } from "@/components/settings";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField, type SelectFieldRenderOptionInput } from "@/components/ui/select-field";
import { ComboboxItem } from "@/components/ui/combobox";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useFetchQuery } from "@/data/query";
import { pluginRegistry, useInstalledPlugin } from "@/plugins/registry";
import { getHostRuntimeStore, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  getPwaDefaultChoices,
  getPwaSourceSaveFields,
  openPwaForm,
  pwaSourceSchema,
  savedPwaSourceSchema,
  type PwaFormSnapshot,
  type PwaFormState,
} from "./pwa-form-model";

interface ProjectPwaSettingsProps {
  serverId: string;
  projectId: string;
}

export function ProjectPwaSettings(props: ProjectPwaSettingsProps) {
  return <ProjectPwaSettingsSession key={`${props.serverId}:${props.projectId}`} {...props} />;
}

function ProjectPwaSettingsSession({ serverId, projectId }: ProjectPwaSettingsProps) {
  const { t } = useTranslation();
  const plugin = useInstalledPlugin(serverId, "paseo-swarm");
  const connected = useHostRuntimeIsConnected(serverId);
  const available = connected && plugin !== null;
  const invoke = useCallback(
    async (method: string, input: unknown) => {
      if (getHostRuntimeStore().getSnapshot(serverId)?.connectionStatus !== "online") {
        throw new Error(t("common.errors.daemonClientDisconnected"));
      }
      // An open form survives catalog disposal; dispatch through the current installation.
      const currentPlugin = pluginRegistry
        .getSnapshot()
        .find((entry) => entry.serverId === serverId && entry.id === "paseo-swarm");
      if (!currentPlugin) throw new Error(t("swarm.creation.notInstalled"));
      return currentPlugin.invoke(method, input);
    },
    [serverId, t],
  );
  const queryClient = useQueryClient();
  const [session, setSession] = useState<PwaFormSnapshot | null>(null);
  const queryKey = useMemo(
    () => ["swarm", "pwa-source", serverId, projectId],
    [serverId, projectId],
  );
  const query = useFetchQuery({
    queryKey,
    queryFn: available
      ? async () => pwaSourceSchema.parse(await invoke("swarm.pwa_source.read", { projectId }))
      : skipToken,
    dataShape: "value",
    staleTimeMs: 0,
    retry: false,
  });
  const { data, refetch } = query;
  const retry = useCallback(() => {
    if (available) void refetch();
  }, [available, refetch]);
  const open = useCallback(() => {
    if (!available || !data) return;
    setSession({
      path: data.path,
      defaultPwa: data.defaultPwa,
      discovery: data,
      preview: data.discoveryAvailable
        ? async (path) =>
            pwaSourceSchema.parse(
              await invoke("swarm.pwa_source.read", {
                projectId,
                ...(data.sourcePreview === true ? { path } : {}),
              }),
            )
        : undefined,
      async save(path, defaultPwa) {
        const saved = savedPwaSourceSchema.parse(
          await invoke("swarm.pwa_source.set", {
            projectId,
            ...getPwaSourceSaveFields(data, path, defaultPwa),
          }),
        );
        await queryClient.cancelQueries({ queryKey, exact: true });
        void queryClient.invalidateQueries({ queryKey, exact: true });
        void queryClient.invalidateQueries({
          queryKey: ["swarm", "creation-target", serverId, projectId],
        });
        return saved;
      },
    });
  }, [available, invoke, projectId, data, queryClient, queryKey, serverId]);
  const close = useCallback(() => {
    setSession(null);
  }, []);
  if (!plugin && !session) return null;
  let content;
  if (query.isError) {
    content = (
      <SettingsRow label={t("swarm.pwa.contentRoot")} error={query.error.message}>
        <Button variant="outline" size="sm" onPress={retry} disabled={!available}>
          {t("common.actions.retry")}
        </Button>
      </SettingsRow>
    );
  } else if (!query.data) {
    content = (
      <SettingsRow label={t("swarm.pwa.contentRoot")} hint={t("common.states.loading")}>
        <Button variant="outline" size="sm" disabled>
          {t("swarm.pwa.edit")}
        </Button>
      </SettingsRow>
    );
  } else {
    content = (
      <SettingsRow
        label={t("swarm.pwa.contentRoot")}
        hint={[
          query.data.path ?? t("swarm.pwa.notConfigured"),
          query.data.discoveryAvailable &&
            (query.data.defaultPwa
              ? t("swarm.pwa.defaultValue", { directory: query.data.defaultPwa })
              : t("swarm.pwa.noDefault")),
          query.data.rootError,
          query.data.discoveryAvailable &&
            (query.data.complete
              ? t("swarm.pwa.discovered", { count: query.data.entries.length })
              : t("swarm.pwa.partial")),
          ...query.data.entries
            .filter((entry) => entry.error)
            .map((entry) => `${entry.title} · ${entry.directory}: ${entry.error}`),
          ...query.data.errors.map((entry) => `${entry.directory}: ${entry.error}`),
        ]
          .filter(Boolean)
          .join("\n")}
      >
        <Button
          variant="outline"
          size="sm"
          onPress={open}
          disabled={!available}
          testID="project-pwa-edit"
        >
          {t("swarm.pwa.edit")}
        </Button>
      </SettingsRow>
    );
  }
  return (
    <SettingsSection title={t("swarm.pwa.section")} testID="project-pwa-settings">
      <SettingsCard>{content}</SettingsCard>
      {session ? <PwaFormSheet snapshot={session} available={available} onClose={close} /> : null}
    </SettingsSection>
  );
}

function usePwaForm(snapshot: PwaFormSnapshot) {
  const [form] = useState(() => openPwaForm(snapshot));
  useEffect(() => () => form.close(), [form]);
  const state = useSyncExternalStore(form.subscribe, form.getState, form.getState);
  return { form, state };
}

function PwaFormSheet({
  snapshot,
  available,
  onClose,
}: {
  snapshot: PwaFormSnapshot;
  available: boolean;
  onClose(): void;
}) {
  const { t } = useTranslation();
  const { form, state } = usePwaForm(snapshot);
  const size = useIsCompactFormFactor() ? "md" : "sm";
  const pending = state.status.kind === "pending";
  const error = state.status.kind === "error" ? state.status.message : null;
  const close = useCallback(() => {
    if (!pending) onClose();
  }, [onClose, pending]);
  const submit = useCallback(() => {
    if (available) void form.submit();
  }, [available, form]);
  const header = useMemo(() => ({ title: t("swarm.pwa.contentRoot") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        <Button variant="secondary" onPress={close} disabled={pending}>
          {t("common.actions.close")}
        </Button>
        <Button
          variant="default"
          onPress={submit}
          disabled={!available || !state.canSubmit}
          loading={pending}
          testID="project-pwa-save"
        >
          {t(pending ? "swarm.pwa.saving" : "swarm.pwa.save")}
        </Button>
      </View>
    ),
    [available, close, pending, state.canSubmit, submit, t],
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
      <Field
        label={t("swarm.pwa.directoryLabel")}
        error={error}
        testID="project-pwa-directory-field"
      >
        <FormTextInput
          key={state.inputRevision}
          initialValue={state.path}
          onChangeText={form.setPath}
          size={size}
          editable={!pending}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel={t("swarm.pwa.contentRoot")}
          testID="project-pwa-directory"
        />
      </Field>
      {snapshot.discovery?.discoveryAvailable ? (
        <PwaDefaultField
          state={state}
          form={form}
          size={size}
          pending={pending}
          available={available}
        />
      ) : null}
      {state.status.kind === "success" ? (
        <Alert variant="success" title={t("swarm.pwa.saved")} testID="project-pwa-saved" />
      ) : null}
    </AdaptiveModalSheet>
  );
}

function PwaDefaultField({
  state,
  form,
  size,
  pending,
  available,
}: {
  state: PwaFormState;
  form: ReturnType<typeof openPwaForm>;
  size: "sm" | "md";
  pending: boolean;
  available: boolean;
}) {
  const { t } = useTranslation();
  const source = state.preview.kind === "loaded" ? state.preview.source : undefined;
  const choices = useMemo(
    () => getPwaDefaultChoices(source?.entries ?? [], state.defaultPwa),
    [source, state.defaultPwa],
  );
  const options = useMemo(
    () =>
      choices.map((choice) => ({
        id: choice.directory ? `pwa:${choice.directory}` : "none",
        value: choice.directory,
        label: choice.directory
          ? `${choice.title} · ${choice.directory}`
          : t("swarm.pwa.noDefault"),
        description: choice.error,
      })),
    [choices, t],
  );
  const display = useMemo(
    () => ({ label: state.defaultPwa || t("swarm.pwa.noDefault") }),
    [state.defaultPwa, t],
  );
  const renderOption = useCallback(
    ({ option, selected, active, onPress }: SelectFieldRenderOptionInput<string>) => (
      <ComboboxItem
        label={option.label}
        description={option.description}
        selected={selected}
        active={active}
        disabled={!choices.find((choice) => choice.directory === option.value)?.available}
        onPress={onPress}
      />
    ),
    [choices],
  );
  const change = useCallback(
    (value: string) => {
      if (choices.some((choice) => choice.directory === value && choice.available))
        form.setDefaultPwa(value);
    },
    [choices, form],
  );
  let error: string | undefined;
  if (state.preview.kind === "unsupported") error = t("swarm.pwa.selectionUnavailable");
  else if (state.preview.kind === "error") error = state.preview.message;
  else if (source?.rootError) error = source.rootError;
  else if (
    source &&
    !choices.some((choice) => choice.directory === state.defaultPwa && choice.available)
  )
    error = t("swarm.pwa.selectionUnavailable");
  const retry = useCallback(() => {
    if (available) void form.refreshPreview();
  }, [available, form]);
  return (
    <>
      <SelectField
        label={t("swarm.pwa.defaultDirectory")}
        value={state.defaultPwa}
        selectedDisplay={display}
        options={options}
        onChange={change}
        placeholder={t("swarm.pwa.noDefault")}
        emptyText={t("swarm.pwa.empty")}
        size={size}
        loading={state.preview.kind === "loading"}
        disabled={!available || pending || !source}
        error={error}
        hint={source && !source.complete ? t("swarm.pwa.partial") : undefined}
        renderOption={renderOption}
        testID="project-pwa-default-field"
        triggerTestID="project-pwa-default"
      />
      {state.preview.kind === "error" || source?.rootError || (source && !source.complete) ? (
        <Button variant="outline" size={size} onPress={retry} disabled={!available || pending}>
          {t("common.actions.retry")}
        </Button>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
