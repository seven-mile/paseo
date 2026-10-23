import type { PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { TurnOutcome } from "./prompts";

type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

export interface TurnSummary {
  outcome: TurnOutcome;
  detail: string | null;
  report: string | null;
  filesChanged: number;
}

// The final run of assistant text, which is what the turn ended on.
function finalReport(timeline: TurnEnded["timeline"]): string | null {
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    if (timeline[index]?.type !== "assistant_message") continue;
    const parts: string[] = [];
    for (
      let cursor = index;
      cursor >= 0 && timeline[cursor]?.type === "assistant_message";
      cursor -= 1
    ) {
      const message = timeline[cursor];
      if (message?.type === "assistant_message") parts.unshift(message.text);
    }
    return parts.join("").trim() || null;
  }
  return null;
}

function filesChanged(timeline: TurnEnded["timeline"]): number {
  const paths = new Set<string>();
  for (const item of timeline) {
    if (item.type !== "tool_call" || item.status !== "completed") continue;
    if (item.detail.type === "edit" || item.detail.type === "write") {
      paths.add(item.detail.filePath);
    }
  }
  return paths.size;
}

function outcomeDetail(outcome: TurnEnded["outcome"]): string | null {
  if (outcome.kind === "canceled") return outcome.reason;
  if (outcome.kind === "failed") return outcome.error.message;
  return null;
}

export function summarizeTurn(event: Pick<TurnEnded, "outcome" | "turnTimeline">): TurnSummary {
  const timeline = event.turnTimeline ?? [];
  const { outcome } = event;
  return {
    outcome: outcome.kind,
    detail: outcomeDetail(outcome),
    report: finalReport(timeline),
    filesChanged: filesChanged(timeline),
  };
}
