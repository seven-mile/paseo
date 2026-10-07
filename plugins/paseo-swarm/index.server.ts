import type { PluginServerContext } from "@getpaseo/plugin/server";
import { notifyManager, registerOperations } from "./server/operations";

export default function contribute(server: PluginServerContext) {
  registerOperations(server);
  server.on("agent.turn_ended", async (event, context) => {
    let detail: string;
    if (event.outcome.kind === "completed") detail = "turn completed";
    else if (event.outcome.kind === "canceled") detail = `canceled: ${event.outcome.reason}`;
    else detail = `failed: ${event.outcome.error.message}`;
    let report: string | undefined;
    for (let index = event.timeline.length - 1; index >= 0; index -= 1) {
      const item = event.timeline[index];
      if (item?.type !== "assistant_message") continue;
      const parts: string[] = [];
      for (
        let cursor = index;
        cursor >= 0 && event.timeline[cursor]?.type === "assistant_message";
        cursor -= 1
      ) {
        const message = event.timeline[cursor];
        if (message?.type === "assistant_message") parts.unshift(message.text);
      }
      report = parts.join("").trim() || undefined;
      break;
    }
    await notifyManager(event.agent, event.outcome.kind, detail, report, context);
  });
  return async () => {};
}
