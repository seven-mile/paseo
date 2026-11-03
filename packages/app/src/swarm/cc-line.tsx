import { useCallback } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { X } from "lucide-react-native";
import { Button } from "@/components/ui/button";

// Who a person's Swarm message goes to: the recipient answers it, and each Cc seat is informed.
// The default Cc can be removed per message and offered again.
export function SwarmCcLine({
  recipient,
  cc,
  defaultCc,
  disabled,
  onRemove,
  onRestore,
}: {
  recipient: string;
  cc: readonly string[];
  defaultCc: readonly string[];
  disabled?: boolean;
  onRemove: (name: string) => void;
  onRestore: () => void;
}) {
  const { t } = useTranslation();
  const restorable = cc.length === 0 && defaultCc.length > 0;
  return (
    <View style={styles.row} testID="swarm-cc-line">
      <Text style={styles.label}>{t("swarm.cc.to", { name: recipient })}</Text>
      {cc.length > 0 ? <Text style={styles.label}>{t("swarm.cc.cc")}</Text> : null}
      {cc.map((name) => (
        <CcEntry key={name} name={name} disabled={disabled} onRemove={onRemove} />
      ))}
      {restorable ? (
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          onPress={onRestore}
          testID="swarm-cc-restore"
        >
          {t("swarm.cc.add", { names: defaultCc.join(", ") })}
        </Button>
      ) : null}
    </View>
  );
}

function CcEntry({
  name,
  disabled,
  onRemove,
}: {
  name: string;
  disabled?: boolean;
  onRemove: (name: string) => void;
}) {
  const { t } = useTranslation();
  const remove = useCallback(() => onRemove(name), [onRemove, name]);
  return (
    <Button
      variant="outline"
      size="xs"
      leftIcon={X}
      disabled={disabled}
      onPress={remove}
      accessibilityLabel={t("swarm.cc.remove", { name })}
      testID={`swarm-cc-${name}`}
    >
      {name}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: theme.spacing[1] },
  label: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
