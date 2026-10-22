import type { PluginServerContext } from "@getpaseo/plugin/server";
import { flushMailbox, markConsumed } from "./server/mailbox";
import { notifyManager, registerOperations } from "./server/operations";

export default function contribute(server: PluginServerContext) {
  registerOperations(server);
  server.on("agent.turn_ended", async (event, context) => {
    if (event.outcome.kind === "completed") await markConsumed(event.agent.id);
    let detail: string;
    if (event.outcome.kind === "completed") detail = "turn completed";
    else if (event.outcome.kind === "canceled") detail = `canceled: ${event.outcome.reason}`;
    else detail = `failed: ${event.outcome.error.message}`;
    let report: string | undefined;
    const timeline = event.turnTimeline ?? [];
    for (let index = timeline.length - 1; index >= 0; index -= 1) {
      const item = timeline[index];
      if (item?.type !== "assistant_message") continue;
      const parts: string[] = [];
      for (
        let cursor = index;
        cursor >= 0 && timeline[cursor]?.type === "assistant_message";
        cursor -= 1
      ) {
        const message = timeline[cursor];
        if (message?.type === "assistant_message") parts.unshift(message.text);
      }
      report = parts.join("").trim() || undefined;
      break;
    }
    await notifyManager(event.agent, event.outcome.kind, detail, report, context);
    // Any turn end is a chance to retry mail that earlier sends could not deliver,
    // including mail left queued when the daemon last stopped.
    await flushMailbox(context);
  });
  return async () => {};
}
