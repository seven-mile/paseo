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
import { useSwarmRpc } from "./rpc";

// The name a person's mail carries, as a person's Activities do.
const HUMAN_SENDER = "human";

const receiptSchema = z.object({
  status: z.enum(["queued", "delivered", "consumed", "failed"]),
  receipt: z.string(),
});

export interface SwarmMessageTarget {
  swarmId?: string;
  name: string;
  qualifiedName?: string;
}

// Mail to a seat goes through its Swarm mailbox, so a seat with no agent yet starts its first one
// with this message as its first instruction.
export function SwarmMessageSeatSheet({
  serverId,
  seat,
  onClose,
  onSent,
}: {
  serverId: string;
  seat: SwarmMessageTarget | null;
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

  useEffect(() => {
    if (!visible) return;
    setBody("");
    setError(null);
    setPending(false);
    const timeout = setTimeout(() => inputRef.current?.focus(), 50);
    return () => clearTimeout(timeout);
  }, [visible, recipient]);

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
          senderName: HUMAN_SENDER,
          recipientName: recipient,
          body: body.trim(),
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
  }, [body, invoke, onClose, onSent, pending, recipient, seat, t]);
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
