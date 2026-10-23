import type { PluginServerContext } from "@getpaseo/plugin/server";
import { approvals } from "./server/approvals";
import { startGate } from "./server/gate";
import { applyChoiceDefaults } from "./server/inbox";
import { flushMailbox, markConsumed, noteTurnEnded, noteTurnStarted } from "./server/mailbox";
import { notifyManager, registerOperations } from "./server/operations";
import { attachPaseo, currentPaseo } from "./server/runtime";
import { getGateDirectory, store } from "./server/state";
import { summarizeTurn } from "./server/turns";

// How often choices past their deadline get their default applied.
const CHOICE_DEFAULT_INTERVAL_MS = 30_000;

export default function contribute(server: PluginServerContext) {
  registerOperations(server);
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
      if (!running || !isRosterMember(request.agentId)) return;
      return { ...request, env: running.env(request.env) };
    });
  }
  server.on("agent.permission_resolved", async (event, context) => {
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
  server.on("agent.turn_started", (event) => {
    noteTurnStarted(event.agent.id);
  });
  server.on("agent.turn_ended", async (event, context) => {
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
    applyChoiceDefaults(paseo).catch((error: unknown) => {
      console.warn("[paseo-swarm] Could not apply choice defaults:", error);
    });
  }, CHOICE_DEFAULT_INTERVAL_MS);
  choiceTimer.unref();
  return async () => {
    clearInterval(choiceTimer);
    await (await gate)?.close();
  };
}

// Every agent session open waits on this check, so unreadable Swarm state must not stop
// agents from starting.
function isRosterMember(paseoAgentId: string): boolean {
  try {
    return store
      .read()
      .agents.some((agent) => agent.paseoAgentId === paseoAgentId && !agent.retired);
  } catch (error) {
    console.error("[paseo-swarm] Could not read the roster for the approval gate:", error);
    return false;
  }
}
