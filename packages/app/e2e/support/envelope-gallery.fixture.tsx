import "../../src/styles/unistyles";
// oxlint-disable-next-line import/no-unassigned-import -- Use the actual Expo Metro runtime.
import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ScrollView, Text, View } from "react-native";
import { UnistylesRuntime } from "react-native-unistyles";
import { UserMessage } from "../../src/components/message";
import { ToastApiProvider } from "../../src/contexts/toast-api-context";
import { i18n } from "../../src/i18n/i18next";
import { lightTheme, darkTheme } from "../../src/styles/theme";
import { isWeb } from "../../src/constants/platform";

const params = isWeb ? new URLSearchParams(window.location.search) : new URLSearchParams();
const themeName = params.get("theme") === "dark" ? "dark" : "light";
const theme = themeName === "dark" ? darkTheme : lightTheme;
const client = new QueryClient();
const toast = { show() {}, copied() {}, error() {} };
const examples = [
  {
    kind: "settings",
    original:
      "<paseo-swarm-system-settings>\nThese are framework-provided role-class operating settings. They describe how this agent participates in the swarm; they are not a Task completion signal and do not grant capabilities beyond the tools that are available.\nRole class guidance: You are a supervisor. Own the Tasks in your scope and direct named Swarm workers.\nWhen context is rebuilt after compaction, preserve these settings and apply them before project and Task context.\n</paseo-swarm-system-settings>\nYou are planner.ui-evolution, the canonical agent name for this project. Your local name is ui-evolution.\nProject: UI review. Role class: supervisor. Role: reviewer.\nReports to: planner. PWA revision: example-revision.\nProject statuses: survey, review.\n\nProject working agreement:\n## Project guidance\n\nKeep the existing workspace and preserve user edits.\n\n- Inspect the current source.\n- Report observed behavior.\n\nYour role guidance (reviewer):\nRead the source and inspect actual UI evidence.\n\nOrientation: Review the existing message card.",
  },
  {
    kind: "team",
    original:
      '<paseo-swarm-team-message>\nThis is an agent-to-agent team message delivered through Paseo.\nTask: ui-swarm-system-envelopes.\nTeam message from planner.ui-evolution.sidebar-dev to planner.ui-evolution:\n## Review ready\n\nThe card uses **existing Paseo controls**. A longer paragraph should wrap inside the message at narrow widths without hiding the disclosure or timestamp.\n\n1. Read the current source.\n2. Expand the original text.\n3. Keep raw identifiers unchanged.\n\n`source/path/with-a-long-name-that-needs-to-remain-readable.tsx`\n\n```ts\nconst note = "Keep raw text unchanged";\n```\n\n> Quoted review note\n> > Nested quotation stays ordinary body text.\n\n项目上下文：保留当前源码与草稿。多行中文、English text 和 😀 应当保持正常行距。\n\nRecipient: planner.ui-evolution.\nDelivery does not prove that the recipient read, understood, or completed the message.\nDo not acknowledge receipts or status notices, and do not send thanks, received, or stand by.\n</paseo-swarm-team-message>',
  },
  {
    kind: "runtime",
    original:
      "<paseo-swarm-runtime-notification>\nFramework roster notification; this is not an agent-authored team message.\nAgent planner.ui-evolution.sidebar-dev turn ended with runtime outcome: completed.\nRuntime detail: The source review ended.\nObserved assistant text from this turn; captured by the framework, not sent as a team message:\nWorker turn ended. The manager still decides the next business step.\n\n> Review evidence is separate from a Task decision.\n\nThis runtime outcome does not establish Task completion, success, failure, or cancellation.\nThe agent will do no further work unless it receives a next instruction.\nManager planner.ui-evolution must evaluate the next business step from the available evidence and PWA, send a next instruction when the agent should continue, and continue coordinating until genuinely blocked or completed.\nThis is a runtime notification, not a business activity.\n</paseo-swarm-runtime-notification>",
  },
] as const;
const rows = examples.map((example) => ({ example, dataSet: { example: example.kind } }));
const fallbackDataSet = { example: "fallback" };
const outer = { flex: 1, backgroundColor: theme.colors.background };
const content = {
  padding: 20,
  gap: 24,
  width: "100%" as const,
  maxWidth: 860,
  alignSelf: "center" as const,
};
const label = { color: theme.colors.foregroundMuted, fontSize: 14 };
function Gallery() {
  return (
    <SafeAreaProvider style={outer}>
      <QueryClientProvider client={client}>
        <ToastApiProvider api={toast}>
          <ScrollView contentContainerStyle={content}>
            <Text style={label}>Swarm system envelopes · real UserMessage fixture</Text>
            {rows.map(({ example, dataSet }) => (
              <View key={example.kind} dataSet={dataSet}>
                <UserMessage
                  messageId={`visual-${example.kind}`}
                  message={example.original}
                  timestamp={1700000000000}
                  client={null}
                />
              </View>
            ))}
            <View dataSet={fallbackDataSet}>
              <UserMessage
                messageId="visual-fallback"
                message={
                  "<paseo-swarm-unknown>\nUnrecognized tags stay visible as ordinary text.\n</paseo-swarm-unknown>"
                }
                timestamp={1700000000000}
                client={null}
              />
            </View>
          </ScrollView>
        </ToastApiProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
if (isWeb) {
  UnistylesRuntime.setAdaptiveThemes(false);
  UnistylesRuntime.setTheme(themeName);
  void i18n
    .changeLanguage(params.get("lang") === "zh" ? "zh-CN" : "en")
    .then(() => registerRootComponent(Gallery));
}
