import type { PluginServerContext } from "@getpaseo/plugin/server";
import { flushMailbox, markConsumed, noteTurnEnded, noteTurnStarted } from "./server/mailbox";
import { notifyManager, registerOperations } from "./server/operations";
import { backfillSwarms } from "./server/swarms";
import { summarizeTurn } from "./server/turns";

export default function contribute(server: PluginServerContext) {
  // Records from before swarms get theirs before any request or hook reads them. A failed
  // backfill fails every request with its error, rather than serving unscoped records.
  const ready = backfillSwarms();
  ready.catch((error) => {
    console.error("[paseo-swarm] Could not give records from before swarms their swarm", error);
  });
  registerOperations({
    handle(contract, handler) {
      server.handle(contract, async (input, context) => {
        await ready;
        return handler(input, context);
      });
    },
  });
  server.on("agent.turn_started", async (event) => {
    await ready;
    noteTurnStarted(event.agent.id);
  });
  server.on("agent.turn_ended", async (event, context) => {
    await ready;
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
