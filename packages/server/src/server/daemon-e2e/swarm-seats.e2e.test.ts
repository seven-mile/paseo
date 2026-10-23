import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, expect, test } from "vitest";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

interface Seat {
  name: string;
  paseoAgentId: string;
  occupant: { number: number };
  pastOccupants?: Array<{ number: number; paseoAgentId: string }>;
}

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function setEnv(name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  cleanups.push(async () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out at ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// A seat moved to another provider gets a fresh agent on its next Swarm delivery, against a real
// daemon: the Paseo agent API, archive cascade, and history reads the seat unit tests fake.
test("a Swarm seat moves to another provider and back to its first agent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "swarm-seats-e2e-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  execSync("git init -b main", { cwd: root, stdio: "pipe" });
  setEnv(
    "PASEO_SWARM_PWA_ROOT",
    fileURLToPath(new URL("../../../../../plugins/paseo-swarm/pwa/pr-workflow", import.meta.url)),
  );
  const daemon = await createTestPaseoDaemon({
    isDev: true,
    pluginsEnabled: true,
    builtinPlugins: new BuiltinPluginLoader(undefined, ["paseo-swarm"]),
    providerOverrides: { "mock-b": { extends: "mock", label: "Mock B" } },
  });
  cleanups.push(() => daemon.close());
  setEnv("PASEO_HOME", daemon.paseoHome);
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  cleanups.push(() => client.close());
  await client.connect();
  await client.fetchAgents({ subscribe: {} });
  const swarm = <T>(method: string, input: unknown) =>
    client.invokePluginRpc("paseo-swarm", method, input) as Promise<T>;
  const agents = async () =>
    new Map(
      (await client.fetchAgents({ filter: { includeArchived: true } })).entries.map((entry) => [
        entry.agent.id,
        entry.agent,
      ]),
    );

  const { workspace } = await client.createWorkspace({ source: { kind: "directory", path: root } });
  const config = { provider: "mock/e2e-fast-stream", modeId: "load-test" };
  const lead = await swarm<Seat>("swarm.agent.create", {
    ...config,
    name: "lead",
    roleClass: "supervisor",
    role: "supervisor",
    workspaceId: workspace!.id,
  });
  const dev = await swarm<Seat>("swarm.agent.create", {
    ...config,
    name: "dev",
    roleClass: "worker",
    role: "developer",
    reportsTo: "lead",
  });
  await client.waitForFinish(dev.paseoAgentId, 30_000);
  expect((await agents()).get(dev.paseoAgentId)?.labels[PARENT_AGENT_ID_LABEL]).toBe(
    lead.paseoAgentId,
  );

  await expect(
    swarm("swarm.seat.update", { seats: ["lead"], agentConfig: { provider: "mock-b" } }),
  ).rejects.toThrow(/needs provider\/model and a mode/);
  await swarm("swarm.seat.update", {
    seats: ["lead"],
    agentConfig: { provider: "mock-b/e2e-fast-stream", modeId: "load-test" },
  });
  await swarm("swarm.message.send", {
    recipientPaseoAgentId: lead.paseoAgentId,
    recipientName: "lead",
    senderName: "human",
    body: "SEAT_E2E_STATUS",
  });

  const listSeat = async () =>
    (await swarm<{ seats: Seat[] }>("swarm.seat.list", {})).seats.find(
      (seat) => seat.name === "lead",
    )!;
  const moved = await waitFor(listSeat, (seat) => seat.occupant.number === 2);
  expect(moved.pastOccupants?.map((past) => past.paseoAgentId)).toEqual([lead.paseoAgentId]);
  // The seat is rebound first; the old agent is archived and the mail delivered right after.
  const after = await waitFor(agents, (all) => Boolean(all.get(lead.paseoAgentId)?.archivedAt));
  expect(after.get(moved.paseoAgentId)?.provider).toBe("mock-b");
  // The worker was detached before its old manager was archived, so it is still live.
  expect(after.get(dev.paseoAgentId)?.archivedAt).toBeNull();
  expect(after.get(dev.paseoAgentId)?.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
  await waitFor(
    () =>
      client.fetchAgentTimeline(moved.paseoAgentId, {
        direction: "tail",
        limit: 0,
        projection: "canonical",
      }),
    (timeline) =>
      timeline.entries.some(
        (entry) =>
          entry.item.type === "user_message" && entry.item.text.includes("SEAT_E2E_STATUS"),
      ),
  );

  // The mock provider keeps no transcript once its session closes, so this checks the read
  // path only: it names the earlier occupant and leaves it archived.
  const history = await swarm<{ occupant: number; paseoAgentId: string }>(
    "swarm.seat.history.read",
    { seat: "lead" },
  );
  expect(history).toMatchObject({ occupant: 1, paseoAgentId: lead.paseoAgentId });
  expect((await agents()).get(lead.paseoAgentId)?.archivedAt).toBeTruthy();

  // Moving back brings the first agent back with its context.
  await swarm("swarm.seat.update", { seats: ["lead"], agentConfig: config });
  await swarm("swarm.message.send", {
    recipientPaseoAgentId: moved.paseoAgentId,
    recipientName: "lead",
    senderName: "human",
    body: "SEAT_E2E_BACK",
  });
  const back = await waitFor(listSeat, (seat) => seat.paseoAgentId === lead.paseoAgentId);
  expect(back.occupant.number).toBe(1);
  const returned = await waitFor(agents, (all) => Boolean(all.get(moved.paseoAgentId)?.archivedAt));
  expect(returned.get(lead.paseoAgentId)?.archivedAt).toBeNull();
  const leadSaw = (text: string) =>
    waitFor(
      () =>
        client.fetchAgentTimeline(lead.paseoAgentId, {
          direction: "tail",
          limit: 0,
          projection: "canonical",
        }),
      (timeline) =>
        timeline.entries.some(
          (entry) => entry.item.type === "user_message" && entry.item.text.includes(text),
        ),
    );
  await leadSaw("SEAT_E2E_BACK");

  // A mode change is made on the live agent, which stays in the seat.
  await client.waitForFinish(lead.paseoAgentId, 30_000);
  await swarm("swarm.seat.update", { seats: ["lead"], agentConfig: { modeId: "approval-test" } });
  await swarm("swarm.message.send", {
    recipientPaseoAgentId: lead.paseoAgentId,
    recipientName: "lead",
    senderName: "human",
    body: "SEAT_E2E_MODE",
  });
  await waitFor(agents, (all) => all.get(lead.paseoAgentId)?.currentModeId === "approval-test");
  await leadSaw("SEAT_E2E_MODE");
  expect((await listSeat()).paseoAgentId).toBe(lead.paseoAgentId);
}, 120_000);
