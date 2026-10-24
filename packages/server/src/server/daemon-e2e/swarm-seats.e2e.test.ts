import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { afterEach, expect, test } from "vitest";
import type {
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSessionConfig,
} from "../agent/agent-sdk-types.js";
import { MockLoadTestAgentClient } from "../agent/providers/mock-load-test-agent.js";
import { BuiltinPluginLoader } from "../plugins/builtin/index.js";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";

interface Seat {
  name: string;
  paseoAgentId: string | null;
  occupant: { number: number };
  pastOccupants?: Array<{ number: number; paseoAgentId: string }>;
}

// A mock provider that takes Paseo tools as a native catalog when its session opens, as OpenCode and
// OMP do, and records the tool names each launch of each agent got.
class NativeToolsMockClient extends MockLoadTestAgentClient {
  override readonly capabilities = {
    ...new MockLoadTestAgentClient().capabilities,
    supportsNativePaseoTools: true,
  };
  readonly launches = new Map<string, string[][]>();

  private record(launchContext: AgentLaunchContext | undefined): void {
    if (!launchContext) return;
    const tools = [...(launchContext.paseoTools?.tools.keys() ?? [])];
    this.launches.set(launchContext.agentId, [
      ...(this.launches.get(launchContext.agentId) ?? []),
      tools,
    ]);
  }

  override async createSession(config: AgentSessionConfig, launchContext?: AgentLaunchContext) {
    this.record(launchContext);
    return super.createSession(config, launchContext);
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ) {
    this.record(launchContext);
    return super.resumeSession(handle, overrides, launchContext);
  }
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

// A reserved seat starts its agent on its first message, and a seat moved to another provider gets
// a fresh agent on its next Swarm delivery, against a real daemon: the Paseo agent API, archiving,
// and history reads the seat unit tests fake. Each agent a seat starts or brings back opens its
// session with the seat's Swarm tools and without native agent-driving ones.
test("a Swarm seat starts on its first message, moves to another provider, and back", async () => {
  const mockA = new NativeToolsMockClient();
  const mockB = new NativeToolsMockClient();
  // The tools the latest launch of an agent opened its session with.
  const launchTools = (agentId: string) =>
    (mockA.launches.get(agentId) ?? mockB.launches.get(agentId) ?? []).at(-1) ?? [];
  const launchCount = (agentId: string) =>
    (mockA.launches.get(agentId)?.length ?? 0) + (mockB.launches.get(agentId)?.length ?? 0);
  const expectSeatTools = (agentId: string, roleClass: "supervisor" | "worker") => {
    const tools = launchTools(agentId);
    expect(tools).toEqual(expect.arrayContaining(["swarm_seat_read", "swarm_message_send"]));
    for (const native of [
      "create_agent",
      "send_agent_prompt",
      "get_agent_activity",
      "create_heartbeat",
      "create_schedule",
      "run_schedule_once",
    ]) {
      expect(tools).not.toContain(native);
    }
    expect(tools).toContain("create_terminal");
    const managerTools = ["swarm_seat_create", "create_workspace"];
    if (roleClass === "supervisor") expect(tools).toEqual(expect.arrayContaining(managerTools));
    else for (const tool of managerTools) expect(tools).not.toContain(tool);
  };
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
    agentClients: { mock: mockA, "mock-b": mockB },
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
  const reserved = await swarm<Seat>("swarm.seat.create", {
    ...config,
    name: "lead",
    roleClass: "supervisor",
    role: "supervisor",
    workspaceId: workspace!.id,
  });
  expect(reserved.paseoAgentId).toBeNull();
  await swarm<Seat>("swarm.seat.create", {
    ...config,
    name: "dev",
    roleClass: "worker",
    role: "developer",
    reportsTo: "lead",
  });
  const listSeat = async (name: string) =>
    (await swarm<{ seats: Seat[] }>("swarm.seat.list", {})).seats.find(
      (seat) => seat.name === name,
    )!;
  const send = (to: string, body: string) =>
    swarm("swarm.message.send", { recipientName: to, senderName: "human", body });
  await send("lead", "SEAT_E2E_START");
  await send("lead.dev", "SEAT_E2E_START");
  const lead = await listSeat("lead");
  const dev = await listSeat("dev");
  const leadAgentId = lead.paseoAgentId!;
  const devAgentId = dev.paseoAgentId!;
  expect(lead.occupant.number).toBe(1);
  expectSeatTools(leadAgentId, "supervisor");
  expectSeatTools(devAgentId, "worker");
  await client.waitForFinish(devAgentId, 30_000);
  // Seat agents have no Paseo parent; the roster's reporting line is Swarm's own.
  expect((await agents()).get(devAgentId)?.labels[PARENT_AGENT_ID_LABEL]).toBeUndefined();
  await client.waitForFinish(leadAgentId, 30_000);

  await expect(
    swarm("swarm.seat.update", { seats: ["lead"], agentConfig: { provider: "mock-b" } }),
  ).rejects.toThrow(/needs provider\/model, and a mode when the seat moves/);
  await swarm("swarm.seat.update", {
    seats: ["lead"],
    agentConfig: { provider: "mock-b/e2e-fast-stream", modeId: "load-test" },
  });
  await send("lead", "SEAT_E2E_STATUS");

  const moved = await waitFor(
    () => listSeat("lead"),
    (seat) => seat.occupant.number === 2,
  );
  const movedAgentId = moved.paseoAgentId!;
  expect(moved.pastOccupants?.map((past) => past.paseoAgentId)).toEqual([leadAgentId]);
  // The seat is rebound first; the old agent is archived and the mail delivered right after.
  const after = await waitFor(agents, (all) => Boolean(all.get(leadAgentId)?.archivedAt));
  expect(after.get(movedAgentId)?.provider).toBe("mock-b");
  expectSeatTools(movedAgentId, "supervisor");
  // Replacing the manager leaves its worker's agent alone.
  expect(after.get(devAgentId)?.archivedAt).toBeNull();
  await waitFor(
    () =>
      client.fetchAgentTimeline(movedAgentId, {
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
    { seat: "lead", occupant: 1 },
  );
  expect(history).toMatchObject({ occupant: 1, paseoAgentId: leadAgentId });
  expect((await agents()).get(leadAgentId)?.archivedAt).toBeTruthy();

  // Moving back brings the first agent back with its context.
  await swarm("swarm.seat.update", { seats: ["lead"], agentConfig: config });
  const leadLaunches = launchCount(leadAgentId);
  await send("lead", "SEAT_E2E_BACK");
  const back = await waitFor(
    () => listSeat("lead"),
    (seat) => seat.paseoAgentId === leadAgentId,
  );
  expect(back.occupant.number).toBe(1);
  const returned = await waitFor(agents, (all) => Boolean(all.get(movedAgentId)?.archivedAt));
  expect(returned.get(leadAgentId)?.archivedAt).toBeNull();
  const leadSaw = (text: string) =>
    waitFor(
      () =>
        client.fetchAgentTimeline(leadAgentId, {
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
  // The archived agent's session reopened for its return turn, already in the seat.
  expect(launchCount(leadAgentId)).toBeGreaterThan(leadLaunches);
  expectSeatTools(leadAgentId, "supervisor");

  // A mode change is made on the live agent, which stays in the seat.
  await client.waitForFinish(leadAgentId, 30_000);
  await swarm("swarm.seat.update", { seats: ["lead"], agentConfig: { modeId: "approval-test" } });
  await send("lead", "SEAT_E2E_MODE");
  await waitFor(agents, (all) => all.get(leadAgentId)?.currentModeId === "approval-test");
  await leadSaw("SEAT_E2E_MODE");
  expect((await listSeat("lead")).paseoAgentId).toBe(leadAgentId);
}, 120_000);
