import type { PluginServerContext } from "@getpaseo/plugin/server";
import { flushMailbox, markConsumed, noteTurnEnded, noteTurnStarted } from "./server/mailbox";
import { notifyManager, registerOperations } from "./server/operations";
import { summarizeTurn } from "./server/turns";

export default function contribute(server: PluginServerContext) {
  registerOperations(server);
  server.on("agent.turn_started", (event) => {
    noteTurnStarted(event.agent.id);
  });
  server.on("agent.turn_ended", async (event, context) => {
    // Cleared first, so the flush below can deliver turn rows held for this agent.
    noteTurnEnded(event.agent.id);
    if (event.outcome.kind === "completed") await markConsumed(event.agent.id);
    await notifyManager(event.agent, summarizeTurn(event), context);
    // Any turn end is a chance to retry mail that earlier sends could not deliver,
    // including mail left queued when the daemon last stopped.
    await flushMailbox(context);
  });
  return async () => {};
}
