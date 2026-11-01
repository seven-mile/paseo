import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { flushMailbox, markConsumed, noteTurnEnded, noteTurnStarted } from "./server/mailbox";
import { migrateStore } from "./server/migration";
import { notifyManager, registerOperations } from "./server/operations";
import { declareTabClose } from "./server/seats";
import { recoverIntents } from "./server/spec";
import { summarizeTurn } from "./server/turns";

export default function contribute(server: PluginServerContext) {
  // A store from before swarms is migrated before any request or hook reads it, and seat changes
  // a crash left half written are settled. A failure fails every request with its error, rather
  // than serving records from before the migration.
  const ready = migrateStore().then(() => recoverIntents());
  ready.catch((error) => {
    console.error("[paseo-swarm] Could not prepare Swarm state", error);
  });
  // Plugins get a Paseo connection only with a request or a hook, so agents started by an older
  // Swarm get their tab-close declaration at the first one after startup. A failure is retried at
  // the next; nothing waits for it.
  let declared: Promise<unknown> | null = null;
  const declare = (context: PluginHandlerContext) => {
    declared ??= declareTabClose(context).catch((error) => {
      declared = null;
      console.warn("[paseo-swarm] Could not declare layout-only tab close", error);
    });
  };
  registerOperations({
    handle(contract, handler) {
      server.handle(contract, async (input, context) => {
        await ready;
        declare(context);
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
    declare(context);
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
