import type { PluginServerContext } from "@getpaseo/plugin/server";
import { approvals } from "./server/approvals";
import { startGate } from "./server/gate";
import { applyChoiceDefaults } from "./server/inbox";
import { flushMailbox, markConsumed, noteTurnEnded, noteTurnStarted } from "./server/mailbox";
import { migrateStore } from "./server/migration";
import { notifyManager, registerOperations } from "./server/operations";
import { attachPaseo, currentPaseo } from "./server/runtime";
import { seatOfAgent } from "./server/seats";
import { recoverIntents } from "./server/spec";
import { getGateDirectory } from "./server/state";
import { summarizeTurn } from "./server/turns";

// How often choices past their deadline get their default applied.
const CHOICE_DEFAULT_INTERVAL_MS = 30_000;

export default function contribute(server: PluginServerContext) {
  // A store from before swarms is migrated before any request or hook reads it, and seat changes
  // a crash left half written are settled. A failure fails every request with its error, rather
  // than serving records from before the migration.
  const ready = migrateStore().then(() => recoverIntents());
  ready.catch((error) => {
    console.error("[paseo-swarm] Could not prepare Swarm state", error);
  });
  registerOperations({
    handle(contract, handler) {
      server.handle(contract, async (input, context) => {
        await ready;
        return handler(input, context);
      });
    },
  });
  // The shims are POSIX shell scripts; Windows agents run ungated, so every session open
  // skips the round trip to this process.
  const gate =
    process.platform === "win32"
      ? null
      : startGate({ directory: getGateDirectory(), handler: approvals.handle }).catch(
          (error: unknown) => {
            console.error("[paseo-swarm] The approval gate did not start:", error);
            return null;
          },
        );
  if (gate) {
    server.before("agent.session_open", async ({ request }, context) => {
      attachPaseo(context.paseo);
      const running = await gate;
      if (!running || !(await isSeatOccupant(ready, request.agentId))) return;
      return { ...request, env: running.env(request.env) };
    });
  }
  server.on("agent.permission_resolved", async (event, context) => {
    await ready;
    await approvals.resolvePermission(
      event.requestId,
      event.resolution.behavior === "allow"
        ? { behavior: "allow" }
        : {
            behavior: "deny",
            ...(event.resolution.message ? { message: event.resolution.message } : {}),
          },
      context.paseo,
    );
  });
  server.on("agent.turn_started", async (event) => {
    await ready;
    noteTurnStarted(event.agent.id);
  });
  server.on("agent.turn_ended", async (event, context) => {
    await ready;
    attachPaseo(context.paseo);
    // Cleared first, so the flush below can deliver turn rows held for this agent.
    noteTurnEnded(event.agent.id);
    if (event.outcome.kind === "completed") await markConsumed(event.agent.id);
    await notifyManager(event.agent, summarizeTurn(event), context);
    // Any turn end is a chance to retry mail that earlier sends could not deliver,
    // including mail left queued when the daemon last stopped.
    await flushMailbox(context);
  });
  const choiceTimer = setInterval(() => {
    const paseo = currentPaseo();
    if (!paseo) return;
    ready
      .then(() => applyChoiceDefaults(paseo))
      .catch((error: unknown) => {
        console.warn("[paseo-swarm] Could not apply choice defaults:", error);
      });
  }, CHOICE_DEFAULT_INTERVAL_MS);
  choiceTimer.unref();
  return async () => {
    clearInterval(choiceTimer);
    await (await gate)?.close();
  };
}

// Every agent session open waits on this check, so Swarm state that failed to load or cannot
// be read must not stop agents from starting. A seat's new agent counts while it arrives.
async function isSeatOccupant(ready: Promise<unknown>, paseoAgentId: string): Promise<boolean> {
  try {
    await ready;
    return seatOfAgent(paseoAgentId) !== undefined;
  } catch (error) {
    console.error("[paseo-swarm] Could not read the seats for the approval gate:", error);
    return false;
  }
}
