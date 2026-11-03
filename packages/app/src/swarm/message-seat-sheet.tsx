import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import type { EditingTextInputHandle } from "@/components/ui/text-input";
import { SwarmCcLine } from "./cc-line";
import { useSwarmRpc } from "./rpc";
import { PERSON_SENDER } from "./system-envelope";

const statusSchema = z.enum(["queued", "delivered", "consumed", "failed"]);
const receiptSchema = z.object({
  status: statusSchema,
  receipt: z.string(),
  // Absent on hosts from before Cc.
  cc: z
    .array(z.object({ recipient: z.string(), messageId: z.string(), status: statusSchema }))
    .optional(),
});
const NO_CC: string[] = [];

export interface SwarmMessageTarget {
  swarmId?: string;
  name: string;
  qualifiedName?: string;
  reportsTo?: string | null;
}

// Mail to a seat goes through its Swarm mailbox, so a seat with no agent yet starts its first one
// with this message as its first instruction.
export function SwarmMessageSeatSheet({
  serverId,
  seat,
  ccSupported = false,
  onClose,
  onSent,
}: {
  serverId: string;
  seat: SwarmMessageTarget | null;
  // The host takes a Cc list on messages.
  ccSupported?: boolean;
  onClose: () => void;
  onSent?: () => void;
}) {
  const { t } = useTranslation();
  const { invoke } = useSwarmRpc(serverId);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const visible = seat !== null;
  const recipient = seat ? (seat.qualifiedName ?? seat.name) : "";
  const manager = seat?.reportsTo ?? null;
  const defaultCc = useMemo(
    () => (ccSupported && manager ? [manager] : NO_CC),
    [ccSupported, manager],
  );
  const [cc, setCc] = useState<string[]>(NO_CC);

  useEffect(() => {
    if (!visible) return;
    setCc(defaultCc);
    setBody("");
    setError(null);
    setPending(false);
    const timeout = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timeout);
  }, [visible, recipient, defaultCc]);
  const removeCc = useCallback(
    (name: string) => setCc((current) => current.filter((entry) => entry !== name)),
    [],
  );
  const restoreCc = useCallback(() => setCc(defaultCc), [defaultCc]);

  const handleChange = useCallback((value: string) => {
    setBody(value);
    setError(null);
  }, []);

  const handleCancel = useCallback(() => {
    if (!pending) onClose();
  }, [pending, onClose]);

  const send = useCallback(async () => {
    if (!seat || pending || !body.trim()) return;
    setPending(true);
    try {
      const result = receiptSchema.parse(
        await invoke("swarm.message.send", {
          ...(seat.swarmId ? { swarmId: seat.swarmId } : {}),
          senderName: PERSON_SENDER,
          recipientName: recipient,
          body: body.trim(),
          ...(cc.length > 0 ? { cc } : {}),
        }),
      );
      setPending(false);
      if (result.status === "failed") {
        setError(result.receipt);
        return;
      }
      onSent?.();
      onClose();
    } catch (sendError) {
      setPending(false);
      setError(
        sendError instanceof Error && sendError.message
          ? sendError.message
          : t("swarm.message.failed"),
      );
    }
  }, [body, cc, invoke, onClose, onSent, pending, recipient, seat, t]);
  const handleSend = useCallback(() => void send(), [send]);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("swarm.message.title", { name: recipient }) }),
    [recipient, t],
  );

  return (
    <AdaptiveModalSheet
      visible={visible}
      onClose={handleCancel}
      header={header}
      testID="swarm-message-seat"
    >
      <View style={styles.body}>
        {ccSupported ? (
          <SwarmCcLine
            recipient={recipient}
            cc={cc}
            defaultCc={defaultCc}
            disabled={pending}
            onRemove={removeCc}
            onRestore={restoreCc}
          />
        ) : null}
        <AdaptiveTextInput
          ref={inputRef}
          resetKey={recipient}
          initialValue=""
          onChangeText={handleChange}
          placeholder={t("swarm.message.placeholder")}
          accessibilityLabel={t("swarm.message.title", { name: recipient })}
          multiline
          editable={!pending}
          style={styles.input}
          testID="swarm-message-seat-input"
        />
        <Text style={styles.hint}>{t("swarm.message.hint")}</Text>
        {error ? (
          <Text style={styles.errorText} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        <View style={styles.actions}>
          <Button
            variant="secondary"
            size="sm"
            style={styles.actionButton}
            onPress={handleCancel}
            disabled={pending}
          >
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            size="sm"
            style={styles.actionButton}
            onPress={handleSend}
            loading={pending}
            disabled={pending || !body.trim()}
            testID="swarm-message-seat-send"
          >
            {t("swarm.message.send")}
          </Button>
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    gap: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  input: {
    minHeight: 120,
    textAlignVertical: "top",
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  errorText: {
    color: theme.colors.palette.red[300],
    fontSize: theme.fontSize.base,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  actionButton: {
    flex: 1,
  },
}));
