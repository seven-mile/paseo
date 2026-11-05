import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Pressable, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";

// A name inside a line of metadata that opens something: a seat, a Task, an artifact. It reads as
// text on the line's rail, so its glyphs line up with the words around it, which a ghost button's
// padding would push off. The hit area grows outward instead.
export function SwarmInlineLink({
  label,
  onPress,
  disabled = false,
  leading,
  accessibilityLabel,
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  leading?: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const hoverIn = useCallback(() => setHovered(true), []);
  const hoverOut = useCallback(() => setHovered(false), []);
  const textStyle = useMemo(
    () => [styles.text, hovered && !disabled && styles.hovered, disabled && styles.disabled],
    [disabled, hovered],
  );
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={disabled ? DISABLED : undefined}
      disabled={disabled}
      onPress={onPress}
      onHoverIn={hoverIn}
      onHoverOut={hoverOut}
      hitSlop={HIT_SLOP}
      style={styles.link}
      testID={testID}
    >
      {leading}
      <Text style={textStyle} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const HIT_SLOP = { top: 6, bottom: 6, left: 4, right: 4 };
const DISABLED = { disabled: true };

const styles = StyleSheet.create((theme) => ({
  link: { flexDirection: "row", alignItems: "center", gap: theme.spacing[1], flexShrink: 1 },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
  hovered: { textDecorationLine: "underline" },
  disabled: { color: theme.colors.foregroundMuted },
}));
