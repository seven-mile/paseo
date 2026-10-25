import { resolve } from "node:path";
import { assemblePrompt } from "../server/seats";
import { store, type SwarmChange } from "../server/state";
import { backfillSwarms, swarmOf } from "../server/swarms";

export const BUNDLED_PWA = resolve(__dirname, "../pwa/pr-workflow");

// Seeded seats join a swarm the way records from before swarms do, copied from the bundled PR
// workflow PWA unless the test chose another source, and their occupants hold its standing
// prompt, so delivery has no refresh to send first. Without stamp they hold no receipt, as seats
// registered before receipts were recorded.
export async function joinSwarm({ stamp = true } = {}): Promise<void> {
  const previous = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_SWARM_PWA_ROOT ??= BUNDLED_PWA;
  try {
    await backfillSwarms();
  } finally {
    if (previous === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
  }
  if (!stamp) return;
  await store.commit((state) =>
    state.agents
      .filter((seat) => seat.paseoAgentId !== null && !seat.prompt)
      .map(
        (record): SwarmChange => ({
          op: "put",
          collection: "agents",
          record: {
            ...record,
            prompt: assemblePrompt(record, swarmOf(record).source.files).received,
          },
        }),
      ),
  );
}
