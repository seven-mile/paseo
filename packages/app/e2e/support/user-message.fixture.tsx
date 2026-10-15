// Test-only entry for the real UserMessage contract under Metro's web resolver.
import "../../src/styles/unistyles";
// oxlint-disable-next-line import/no-unassigned-import -- Match the existing Metro fixture entry.
import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import type { AgentAttachment } from "@getpaseo/protocol/messages";
import { UserMessage } from "../../src/components/message";
import { ToastApiProvider } from "../../src/contexts/toast-api-context";
import { i18n } from "../../src/i18n/i18next";
import { isWeb } from "../../src/constants/platform";
import {
  findMessageMatches,
  findRenderedMatches,
} from "../../src/agent-stream/chat-find/ranges.web";

const original = "<paseo-swarm-team-message>\nİ😀find **body**\n</paseo-swarm-team-message>";
const attachments: AgentAttachment[] = [
  {
    type: "text",
    mimeType: "text/plain",
    title: "Attached note",
    text: "Existing attachment body",
  },
];
const timestamp = 1_700_000_000_000;
const messageId = "mounted-envelope-message";
const frameStyle = { width: 390 };
const rowDataSet = { messageId };
const queryClient = new QueryClient();
const toastCalls: unknown[][] = [];
const toastErrors: unknown[][] = [];

function recordToast(...args: unknown[]) {
  toastCalls.push(args);
}
function recordToastError(...args: unknown[]) {
  toastErrors.push(args);
}
const toast = { show: recordToast, copied: recordToast, error: recordToastError };

export interface UserMessageFixtureBridge {
  readMessageRanges(query: string): Range[];
  readRenderedRanges(query: string): Range[];
  readInput(): { original: string; attachments: AgentAttachment[]; timestamp: number };
  readToastErrorCount(): number;
}

declare global {
  interface Window {
    __paseoUserMessageFixture?: UserMessageFixtureBridge;
    __paseoUserMessagePlainWrites?: string[];
  }
}

function UserMessageFixture() {
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <ToastApiProvider api={toast}>
          <View style={frameStyle} dataSet={rowDataSet}>
            <UserMessage
              messageId={messageId}
              message={original}
              attachments={attachments}
              timestamp={timestamp}
              client={null}
            />
          </View>
        </ToastApiProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

if (isWeb) {
  const previousLanguage = i18n.language;
  window.__paseoUserMessageFixture = {
    readMessageRanges(query) {
      return findMessageMatches(document.getElementById("root"), messageId, query);
    },
    readRenderedRanges(query) {
      const row = document.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (!row) throw new Error("The real UserMessage fixture row is not mounted");
      return findRenderedMatches(row, query);
    },
    readInput() {
      return { original, attachments, timestamp };
    },
    readToastErrorCount() {
      return toastErrors.length;
    },
  };
  window.addEventListener(
    "pagehide",
    () => {
      queryClient.clear();
      delete window.__paseoUserMessageFixture;
      void i18n.changeLanguage(previousLanguage);
    },
    { once: true },
  );
  void i18n.changeLanguage("en").then(() => registerRootComponent(UserMessageFixture));
}
