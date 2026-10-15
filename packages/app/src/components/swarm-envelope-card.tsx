import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ChevronRight } from "lucide-react-native";
import type { RenderRules } from "react-native-markdown-display";
import { mutedIconColorMapping } from "@/components/ui/icon-color";
import { ICON_SIZE } from "@/styles/theme";
import { PlanMarkdownBody } from "@/components/plan-card";
import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import type { SwarmEnvelope } from "@/swarm/system-envelope";
import { createSwarmEnvelopeMarkdownParser } from "@/swarm/envelope-markdown";
import { createSharedMarkdownRules } from "@/components/markdown/renderer";
import { useSwarmCanonicalLinkPress } from "@/swarm/canonical-links";

export interface SwarmEnvelopeCardProps {
  envelope: SwarmEnvelope;
  original: string;
}

interface SwarmEnvelopeOriginalProps {
  original: string;
  expanded: boolean;
  onToggle: () => void;
}

const ThemedChevron = withUnistyles(ChevronRight);
const messageTextDataSet = { messageText: "true" };
const sharedLinkRule = createSharedMarkdownRules().link;
const consumeUnhostedReference = () => false;

export const swarmEnvelopeTitleKeys = {
  settings: "message.envelope.titles.settings",
  team: "message.envelope.titles.team",
  runtime: "message.envelope.titles.runtime",
} as const;

export function SwarmEnvelopeBody({ envelope }: Pick<SwarmEnvelopeCardProps, "envelope">) {
  const canonicalLinkPress = useSwarmCanonicalLinkPress();
  const linkRule = useMemo<RenderRules["link"]>(
    () => (node, children, parent, ruleStyles, onLinkPress) =>
      sharedLinkRule?.(
        node,
        children,
        parent,
        ruleStyles,
        node.attributes["data-swarm-envelope-reference"] === "true" && !canonicalLinkPress
          ? consumeUnhostedReference
          : onLinkPress,
      ),
    [canonicalLinkPress],
  );
  const markdownit = useMemo(
    () => createSwarmEnvelopeMarkdownParser(envelope.kind),
    [envelope.kind],
  );
  return (
    <View style={styles.container} testID="swarm-envelope-body">
      <View dataSet={messageTextDataSet}>
        <PlanMarkdownBody text={envelope.body} markdownit={markdownit} linkRule={linkRule} />
      </View>
    </View>
  );
}

export function SwarmEnvelopeOriginal({
  original,
  expanded,
  onToggle,
}: SwarmEnvelopeOriginalProps) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const handleFocus = useCallback(() => setFocused(true), []);
  const handleBlur = useCallback(() => setFocused(false), []);
  const disclosureState = useMemo(() => ({ expanded }), [expanded]);
  const webExpandedState = useMemo(
    () => (isWeb ? ({ "aria-expanded": expanded } as const) : null),
    [expanded],
  );
  const toggleStyle = useMemo(
    () => [styles.originalToggle, focused && styles.originalToggleFocused],
    [focused],
  );
  const chevronStyle = useMemo(
    () => [styles.chevron, expanded && styles.chevronExpanded],
    [expanded],
  );
  const chevron = useMemo(
    () => (
      <View style={chevronStyle} testID="swarm-envelope-original-chevron">
        <ThemedChevron size={ICON_SIZE.sm} uniProps={mutedIconColorMapping} />
      </View>
    ),
    [chevronStyle],
  );

  return (
    <View style={styles.originalDisclosure} testID="swarm-envelope-original-section">
      <Button
        {...webExpandedState}
        variant="ghost"
        size="sm"
        leftIcon={chevron}
        style={toggleStyle}
        onPress={onToggle}
        onFocus={handleFocus}
        onBlur={handleBlur}
        accessibilityState={disclosureState}
        testID="swarm-envelope-original-toggle"
      >
        {t("message.envelope.originalMessage")}
      </Button>
      {expanded ? (
        <Text selectable style={styles.original} testID="swarm-envelope-original">
          {original}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    alignSelf: "stretch",
    minWidth: 0,
  },
  originalDisclosure: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    alignSelf: "stretch",
    minWidth: 0,
  },
  originalToggle: {
    justifyContent: "flex-start",
    borderWidth: 0,
    borderRadius: 0,
    paddingHorizontal: theme.spacing[3],
  },
  originalToggleFocused: {
    backgroundColor: theme.colors.interactionHighlight,
  },
  chevron: {},
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  original: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    fontFamily: theme.fontFamily.mono,
    ...(isWeb ? { overflowWrap: "anywhere" as const } : {}),
  },
}));
