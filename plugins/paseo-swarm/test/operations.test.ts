import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type {
  PluginHandlerContext,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { forgetRunningTurns } from "../server/mailbox";
import { notifyManager, registerOperations } from "../server/operations";
import { seatView } from "../server/seats";
import { pwaFilesRevision, readPwaFiles } from "../server/pwa";
import { createSwarm, swarmOf } from "../server/swarms";
import { joinSwarm } from "./fixtures";
import {
  getConfigPath,
  getEventLogPath,
  getSnapshotPath,
  StateStore,
  store,
  type SwarmChange,
} from "../server/state";
import { emptyState, type AgentRecord, type SwarmState } from "../shared/models";
import {
  boardReadRpc,
  createSeatRpc,
  sendMessageRpc,
  appendHumanActivityRpc,
  createTaskRpc,
  updateTaskRpc,
  pwaSourceSetRpc,
  pwaSourceReadRpc,
  pwaRolesReadRpc,
  prepareAgentRpc,
  bindPreparedAgentRpc,
  refreshPromptRpc,
} from "../shared/swarm";

async function seed(seeded: SwarmState, options?: { stamp: boolean }): Promise<void> {
  await store.commit(() => [
    ...seeded.agents.map((record): SwarmChange => ({ op: "put", collection: "agents", record })),
    ...seeded.tasks.map((record): SwarmChange => ({ op: "put", collection: "tasks", record })),
    ...seeded.activities.map(
      (record): SwarmChange => ({ op: "put", collection: "activities", record }),
    ),
  ]);
  // Seeded records join a swarm the way records from before swarms do.
  await joinSwarm(options);
}

function readDisk(): string {
  return [getSnapshotPath(), getEventLogPath()]
    .map((path) => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    })
    .join("\0");
}

function boardOf({ messages: _messages, swarms: _swarms, ...board }: Readonly<SwarmState>) {
  return {
    ...board,
    agents: board.agents.filter((agent) => agent.paseoAgentId !== null).map(seatView),
  };
}

test("supervisors require independent placement, workers keep caller defaults, and foreign occupants are rejected", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-operations-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = resolve(__dirname, "../pwa/pr-workflow");
  const seeded = emptyState();
  const planner: AgentRecord = {
    id: "planner-record",
    paseoAgentId: "planner-agent",
    name: "planner",
    qualifiedName: "planner",
    aliases: [],
    roleClass: "planner",
    role: "planner",
    reportsTo: null,
    workspaceId: "planner-workspace",
    retired: false,
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
  };
  seeded.agents.push(planner);
  await seed(seeded);
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  const server: Pick<PluginServerContext, "handle"> = {
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  };
  registerOperations(server);
  const sends: Array<{ agentId: string; text: string; options: unknown }> = [];
  const workspaceCreations: unknown[] = [];
  const agentCreations: Array<{ workspaceId: string; parent: string | undefined }> = [];
  const runtimeWorkspaces = new Map([[planner.paseoAgentId, "planner-workspace"]]);
  const prompts: string[] = [];
  const workspace = (workspaceId: string) => ({
    async refresh() {
      return { projectId: workspaceId === "other-workspace" ? "other" : "project" };
    },
    agents: {
      async create(creation: {
        agentId: string;
        parent?: string;
        config: { systemPrompt: string };
      }) {
        const { agentId } = creation;
        runtimeWorkspaces.set(agentId, workspaceId);
        prompts.push(creation.config.systemPrompt);
        agentCreations.push({ workspaceId, parent: creation.parent });
        return {
          id: agentId,
          async refresh() {
            return { agent: { workspaceId } };
          },
          async send(text: string, options: unknown) {
            sends.push({ agentId, text, options });
          },
        };
      },
    },
  });
  const context = {
    paseo: {
      projects: {
        async list() {
          return {
            projects: [
              { projectId: "project", projectRootPath: home },
              { projectId: "other", projectRootPath: home },
            ],
          };
        },
      },
      agents: {
        async list() {
          return {
            entries: [...runtimeWorkspaces].map(([id, workspaceId]) => ({
              agent: { id, workspaceId },
            })),
            pageInfo: { nextCursor: null },
          };
        },
        ref(agentId: string) {
          return {
            async refresh() {
              return {
                agent: { cwd: "/test/project", workspaceId: runtimeWorkspaces.get(agentId) },
              };
            },
            async send(text: string, options: unknown) {
              sends.push({ agentId, text, options });
            },
          };
        },
        async create() {
          assert.fail("Creation must explicitly place supervisors and workers");
        },
      },
      workspaces: {
        ref: workspace,
        async create(options: unknown) {
          workspaceCreations.push(options);
          return workspace("supervisor-workspace");
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const invoke = (name: string, input: unknown) => handlers.get(name)!(input as never, context);
  try {
    await assert.rejects(
      async () =>
        invoke(
          createSeatRpc.name,
          createSeatRpc.input.parse({
            name: "missing-role",
            roleClass: "supervisor",
            role: "missing",
            workspaceId: "supervisor-workspace",
            actorName: "planner",
            provider: "codex/gpt-6.1-sol",
            reportsTo: "planner",
          }),
        ),
      /Missing role/,
    );
    await assert.rejects(
      async () =>
        invoke(
          createSeatRpc.name,
          createSeatRpc.input.parse({
            name: "wrong-project",
            roleClass: "supervisor",
            role: "supervisor",
            projectId: "other",
            actorName: "planner",
            provider: "codex/gpt-6.1-sol",
            reportsTo: "planner",
          }),
        ),
      /selected project/,
    );
    assert.equal(store.read().agents.length, 1);
    assert.equal(workspaceCreations.length, 0);
    const placementError =
      /Prepare a separate workspace for the supervisor and pass its workspaceId/;
    for (const workspaceId of [undefined, null, "planner-workspace"]) {
      await assert.rejects(
        async () =>
          invoke(
            createSeatRpc.name,
            createSeatRpc.input.parse({
              name: "invalid-placement",
              roleClass: "supervisor",
              role: "supervisor",
              actorName: "planner",
              provider: "codex/gpt-6.1-sol",
              reportsTo: "planner",
              workspaceId,
            }),
          ),
        placementError,
      );
      assert.equal(store.read().agents.length, 1);
      assert.equal(agentCreations.length, 0);
    }
    const supervisor = (await invoke(
      createSeatRpc.name,
      createSeatRpc.input.parse({
        name: "supervisor",
        roleClass: "supervisor",
        role: "supervisor",
        actorName: "planner",
        reportsTo: "planner",
        provider: "codex/gpt-6.1-sol",
        modeId: "auto-review",
        workspaceId: "supervisor-workspace",
      }),
    )) as AgentRecord;
    assert.equal(supervisor.workspaceId, "supervisor-workspace");
    assert.deepEqual(workspaceCreations, []);
    const worker = (await invoke(
      createSeatRpc.name,
      createSeatRpc.input.parse({
        name: "scout",
        roleClass: "worker",
        role: "researcher",
        actorName: "planner.supervisor",
        reportsTo: "planner.supervisor",
        provider: "codex/gpt-6.1-sol",
      }),
    )) as AgentRecord;
    assert.equal(worker.workspaceId, supervisor.workspaceId);
    assert.equal(workspaceCreations.length, 0);
    // A new seat has no agent until its first message starts one, with no Paseo parent.
    assert.equal(supervisor.paseoAgentId, null);
    assert.deepEqual(supervisor.pending, { kind: "start", reason: "no agent yet" });
    assert.deepEqual(agentCreations, []);
    await invoke(
      sendMessageRpc.name,
      sendMessageRpc.input.parse({
        senderName: "planner",
        actorName: "planner",
        recipientName: "supervisor",
        body: "Lead the survey",
      }),
    );
    await invoke(
      sendMessageRpc.name,
      sendMessageRpc.input.parse({
        senderName: "planner.supervisor",
        actorName: "planner.supervisor",
        recipientName: "scout",
        body: "Survey the codebase",
      }),
    );
    assert.deepEqual(agentCreations, [
      { workspaceId: "supervisor-workspace", parent: undefined },
      { workspaceId: "supervisor-workspace", parent: undefined },
    ]);
    const seatOf = (seat: AgentRecord) =>
      store.read().agents.find((agent) => agent.id === seat.id)!;
    const supervisorAgent = seatOf(supervisor).paseoAgentId!;
    const workerAgent = seatOf(worker).paseoAgentId!;
    assert.equal(seatOf(supervisor).occupant?.number, 1);
    assert.deepEqual(
      sends.map(({ agentId, text }) => ({ agentId, first: text.includes("Lead the survey") })),
      [
        { agentId: supervisorAgent, first: true },
        { agentId: workerAgent, first: false },
      ],
    );
    assert.equal(supervisor.projectId, "project");
    assert.equal(worker.projectId, "project");
    const createChild = (actor: AgentRecord, name: string, workspaceId?: string) =>
      invoke(
        createSeatRpc.name,
        createSeatRpc.input.parse({
          name,
          actorName: actor.qualifiedName,
          reportsTo: actor.qualifiedName,
          provider: "codex/gpt-6.1-sol",
          roleClass: actor.roleClass === "planner" ? "supervisor" : "worker",
          role: actor.roleClass === "planner" ? "supervisor" : "researcher",
          workspaceId,
        }),
      ) as Promise<AgentRecord>;
    const peerSupervisor = await createChild(
      planner,
      "peer-supervisor",
      "peer-supervisor-workspace",
    );
    assert.equal(peerSupervisor.workspaceId, "peer-supervisor-workspace");
    const parallel = await createChild(supervisor, "parallel", "parallel-workspace");
    assert.equal(parallel.workspaceId, "parallel-workspace");
    assert.equal(parallel.reportsTo, supervisor.qualifiedName);
    const peer = await createChild(supervisor, "parallel-peer", "parallel-workspace");
    assert.equal(peer.reportsTo, supervisor.qualifiedName);
    const savedCount = store.read().agents.length;
    const createdCount = agentCreations.length;
    await assert.rejects(
      async () => createChild(planner, "grandchild-conflict", "parallel-workspace"),
      /outside planner's direct roster/,
    );
    await assert.rejects(
      async () => createChild(peerSupervisor, "sibling-conflict", "parallel-workspace"),
      /outside planner.peer-supervisor's direct roster/,
    );
    await assert.rejects(
      async () => createChild(supervisor, "parent-conflict", "planner-workspace"),
      /outside planner.supervisor's direct roster/,
    );
    runtimeWorkspaces.set("ordinary-native-agent", "occupied-workspace");
    await assert.rejects(
      async () => createChild(supervisor, "native-conflict", "occupied-workspace"),
      /ordinary-native-agent.*outside/,
    );
    runtimeWorkspaces.delete("ordinary-native-agent");
    assert.equal(store.read().agents.length, savedCount);
    assert.equal(agentCreations.length, createdCount);
    const prepareLegacy = (name: string) =>
      invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({ name, roleClass: "planner", role: "planner" }),
      ) as Promise<{ agentId: string; systemPrompt: string; agent: AgentRecord }>;
    const legacyDefault = await prepareLegacy("legacy-default");
    assert.equal(legacyDefault.agent.projectId, undefined);
    runtimeWorkspaces.set(legacyDefault.agentId, "supervisor-workspace");
    const bound = (await invoke(bindPreparedAgentRpc.name, {
      agentId: legacyDefault.agentId,
      workspaceId: "supervisor-workspace",
    })) as AgentRecord;
    assert.equal(bound.projectId, "project");
    // A project given a PWA directory gets a swarm of its own: a copy, so the chosen directory is
    // never written.
    const source = join(home, "agreement");
    mkdirSync(join(source, "roles"), { recursive: true });
    writeFileSync(
      join(source, "PWA.md"),
      "---\nversion: 1\nproject: Override\n---\nFresh project.\n",
    );
    writeFileSync(
      join(source, "roles", "director.md"),
      "---\nversion: 1\nroleClass: planner\n---\nDirect.\n",
    );
    const firstRole = "---\nversion: 1\nroleClass: worker\n---\nFirst role.\n";
    writeFileSync(join(source, "roles", "researcher.md"), firstRole);
    const attached = (await invoke(pwaSourceSetRpc.name, {
      projectId: "project",
      path: "agreement",
    })) as { path: string };
    assert.notEqual(attached.path, source);
    assert.equal(readFileSync(join(attached.path, "roles", "researcher.md"), "utf8"), firstRole);
    assert.deepEqual(await invoke(pwaSourceReadRpc.name, { projectId: "project" }), attached);
    await assert.rejects(
      async () => invoke(pwaSourceSetRpc.name, { projectId: "project", path: "agreement" }),
      /already has a swarm/,
    );
    await assert.rejects(
      async () => invoke(pwaSourceSetRpc.name, { projectId: "missing", path: source }),
      /Unknown project/,
    );
    const choices = (await invoke(pwaRolesReadRpc.name, {
      projectId: "project",
      roleClass: "planner",
    })) as Array<{ role: string }>;
    assert.deepEqual(
      choices.map((role) => role.role),
      ["director"],
    );
    // Edits to the chosen directory or to the swarm's own reach no one until the swarm accepts them.
    for (const directory of [source, attached.path]) {
      writeFileSync(
        join(directory, "PWA.md"),
        "---\nversion: 1\nproject: Override\nstatuses: [review, survey, completed]\n---\nEdited.\n",
      );
    }
    const readStatuses = async () =>
      boardReadRpc.output.parse(await invoke(boardReadRpc.name, { projectId: "project" })).statuses;
    assert.deepEqual(await readStatuses(), []);
    assert.deepEqual(await invoke(boardReadRpc.name, {}), boardOf(store.read()));
    const prepare = (name: string) =>
      invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({
          name,
          projectId: "project",
          roleClass: "worker",
          role: "researcher",
        }),
      ) as Promise<{ agentId: string; systemPrompt: string; agent: AgentRecord }>;
    const first = await prepare("fresh-one");
    assert.match(first.systemPrompt, /Fresh project/);
    assert.match(first.systemPrompt, /First role/);
    writeFileSync(join(attached.path, "roles", "researcher.md"), "invalid");
    const second = await prepare("fresh-two");
    assert.match(second.systemPrompt, /First role/);
    assert.doesNotMatch(prompts[1], /Fresh project/);
    runtimeWorkspaces.set(first.agentId, "other-workspace");
    await assert.rejects(
      async () =>
        invoke(bindPreparedAgentRpc.name, {
          agentId: first.agentId,
          workspaceId: "other-workspace",
        }),
      /selected project/,
    );
    const stored = () => store.read().agents.find((agent) => agent.paseoAgentId === first.agentId);
    assert.equal(stored()?.workspaceId, null);
    runtimeWorkspaces.set(first.agentId, "supervisor-workspace");
    await invoke(bindPreparedAgentRpc.name, {
      agentId: first.agentId,
      workspaceId: "supervisor-workspace",
    });
    assert.equal(stored()?.workspaceId, "supervisor-workspace");
    const initialSends = sends.length;
    await notifyManager(
      { id: workerAgent },
      { outcome: "completed", detail: null, report: "Findings", filesChanged: 0 },
      context,
    );
    await invoke(
      sendMessageRpc.name,
      sendMessageRpc.input.parse({
        senderName: "planner.supervisor.scout",
        recipientName: "planner.supervisor",
        body: "Survey findings",
      }),
    );
    await assert.rejects(
      async () =>
        invoke(
          sendMessageRpc.name,
          sendMessageRpc.input.parse({
            senderName: "planner.supervisor.scout",
            recipientName: "missing",
            body: "Unknown recipient",
          }),
        ),
      /Unknown active agent: missing/,
    );
    await seed({
      ...emptyState(),
      tasks: [
        {
          id: "survey",
          title: "Survey",
          brief: "Survey",
          status: "survey",
          managerName: "planner.supervisor",
          workerNames: [],
          createdBy: "planner",
          data: {},
          createdAt: planner.createdAt,
          updatedAt: planner.updatedAt,
        },
      ],
    });
    await assert.rejects(
      async () =>
        invoke(
          sendMessageRpc.name,
          sendMessageRpc.input.parse({
            senderName: "planner.supervisor.scout",
            actorName: "planner.supervisor.scout",
            recipientName: "planner.supervisor.scout",
            taskId: "survey",
            body: "Not a task member",
          }),
        ),
      /cannot send a message for Task survey/,
    );
    await invoke(
      appendHumanActivityRpc.name,
      appendHumanActivityRpc.input.parse({
        taskId: "survey",
        actorName: "human",
        kind: "decision",
        body: "Continue",
      }),
    );
    const toSupervisor = sends.slice(initialSends);
    assert.equal(toSupervisor.length, 3);
    for (const delivery of toSupervisor) {
      assert.equal(delivery.agentId, supervisorAgent);
      assert.deepEqual(delivery.options, {
        activeTurnBehavior: "steer",
        messageId: (delivery.options as { messageId: string }).messageId,
      });
      assert.match((delivery.options as { messageId: string }).messageId, /^(message|digest)-/);
    }
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  }
});

test("turn notifications use current-turn text without falling back to history", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "swarm-turn-notifications-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const manager: AgentRecord = {
    id: "manager-record",
    paseoAgentId: "manager-agent",
    name: "manager",
    qualifiedName: "manager",
    aliases: [],
    roleClass: "supervisor",
    role: "supervisor",
    reportsTo: null,
    workspaceId: "workspace",
    retired: false,
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
  };
  const worker: AgentRecord = {
    ...manager,
    id: "worker-record",
    paseoAgentId: "worker-agent",
    name: "worker",
    qualifiedName: "manager.worker",
    roleClass: "worker",
    role: "researcher",
    reportsTo: "manager",
  };
  const hooks = new Map<string, (event: never, context: PluginHookContext) => unknown>();
  const server: Pick<PluginServerContext, "handle" | "on"> = {
    handle() {},
    on(name, handler) {
      hooks.set(name, handler);
      return () => {};
    },
  };
  const sends: Array<{ agentId: string; text: string; options: unknown }> = [];
  const context = {
    signal: new AbortController().signal,
    paseo: {
      agents: {
        ref(agentId: string) {
          return {
            async send(text: string, options: unknown) {
              sends.push({ agentId, text, options });
            },
          };
        },
      },
    },
  } as unknown as PluginHookContext;
  const cases: Array<{
    name: string;
    event: Pick<PluginLifecycleEvents["agent.turn_ended"], "turnId" | "outcome" | "turnTimeline">;
    expectedOutput?: string;
  }> = [
    {
      name: "historical response is not repeated when the current turn has no output",
      event: { turnId: "current", outcome: { kind: "completed" }, turnTimeline: [] },
    },
    {
      name: "canceled turn includes only its incomplete assistant peek",
      event: {
        turnId: "current",
        outcome: { kind: "canceled", reason: "stopped" },
        turnTimeline: [
          { type: "assistant_message", text: "PA" },
          { type: "assistant_message", text: "RTIAL" },
        ],
      },
      expectedOutput: "PARTIAL",
    },
    {
      name: "failed turn includes only its incomplete assistant peek",
      event: {
        turnId: "current",
        outcome: { kind: "failed", error: { message: "provider failed" } },
        turnTimeline: [
          { type: "assistant_message", text: "PA" },
          { type: "assistant_message", text: "RTIAL" },
        ],
      },
      expectedOutput: "PARTIAL",
    },
    {
      name: "unavailable turn attribution does not fall back to the full timeline",
      event: { turnId: null, outcome: { kind: "failed", error: { message: "provider failed" } } },
    },
  ];
  try {
    await seed({ ...emptyState(), agents: [manager, worker] });
    contribute(server as PluginServerContext);
    assert.deepEqual([...hooks.keys()], ["agent.turn_started", "agent.turn_ended"]);
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        sends.length = 0;
        // Each scenario finds the manager idle, so its row is not held for a digest.
        forgetRunningTurns();
        const event: PluginLifecycleEvents["agent.turn_ended"] = {
          agent: {
            id: worker.paseoAgentId,
            workspaceId: "workspace",
            parentAgentId: manager.paseoAgentId,
            provider: "claude",
            cwd: home,
            title: null,
          },
          timeline: [
            { type: "assistant_message", text: "OLD" },
            ...(scenario.event.turnTimeline ?? []),
          ],
          ...scenario.event,
        };
        await hooks.get("agent.turn_ended")!(event as never, context);
        assert.deepEqual(
          sends.map(({ agentId, options }) => ({ agentId, options })),
          [
            {
              agentId: manager.paseoAgentId,
              options: {
                activeTurnBehavior: "steer",
                messageId: (sends[0].options as { messageId: string }).messageId,
              },
            },
          ],
        );
        if (scenario.expectedOutput) {
          assert.ok(sends[0].text.includes(scenario.expectedOutput));
        } else {
          assert.ok(!sends[0].text.includes("PARTIAL"));
        }
        assert.doesNotMatch(sends[0].text, /OLD/);
      });
    }
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("human Activity stays saved when notification fails; storage failure still rejects", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-human-activity-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const seeded = emptyState();
  const timestamp = "2026-10-06T00:00:00Z";
  seeded.agents.push({
    id: "manager-record",
    paseoAgentId: "manager-agent",
    name: "manager",
    qualifiedName: "manager",
    aliases: [],
    roleClass: "supervisor",
    role: "supervisor",
    reportsTo: null,
    workspaceId: "workspace",
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  seeded.tasks.push({
    id: "survey",
    title: "Survey",
    brief: "Survey",
    status: "survey",
    managerName: "manager",
    workerNames: [],
    createdBy: "manager",
    data: {},
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  let sends = 0;
  const context = {
    paseo: {
      agents: {
        ref() {
          return {
            async send() {
              sends += 1;
              throw new Error("Manager is offline");
            },
          };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const invoke = () =>
    handlers.get(appendHumanActivityRpc.name)!(
      appendHumanActivityRpc.input.parse({
        taskId: "survey",
        kind: "human-note",
        body: "Continue",
      }) as never,
      context,
    );
  try {
    await seed(seeded);
    const saved = appendHumanActivityRpc.output.parse(await invoke());
    assert.equal(saved.notificationWarning, "Manager is offline");
    assert.equal(sends, 1);
    const persisted = new StateStore().read();
    assert.equal(persisted.activities.length, 1);
    assert.equal(persisted.activities[0].id, saved.id);
    assert.equal("notificationWarning" in persisted.activities[0], false);
    await store.commit((state) =>
      state.agents.map((agent) => ({ op: "delete", collection: "agents", key: agent.id })),
    );
    const missing = appendHumanActivityRpc.output.parse(await invoke());
    assert.match(missing.notificationWarning!, /Unknown active agent/);
    assert.equal(new StateStore().read().activities.length, 2);
    const diskBefore = readDisk();
    // A directory where the log should be makes the append fail on every platform.
    const log = getEventLogPath();
    renameSync(log, `${log}.aside`);
    mkdirSync(log);
    await assert.rejects(async () => invoke());
    rmSync(log, { recursive: true });
    renameSync(`${log}.aside`, log);
    assert.equal(store.read().activities.length, 2);
    assert.equal(readDisk(), diskBefore);
    assert.equal(sends, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("board reads never read a PWA directory; a project's statuses come from its accepted PWA", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-board-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  delete process.env.PASEO_SWARM_PWA_ROOT;
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  const context = {
    paseo: {
      agents: {
        async list() {
          return { entries: [], pageInfo: { nextCursor: null } };
        },
      },
      projects: {
        async list() {
          return { projects: [{ projectId: "project", projectRootPath: home }] };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const invoke = (projectId?: string) =>
    handlers.get(boardReadRpc.name)!({ projectId } as never, context);
  try {
    await seed(emptyState());
    const original = boardOf(store.read());
    const statuses = async (projectId: string) =>
      boardReadRpc.output.parse(await invoke(projectId)).statuses;
    assert.deepEqual(await invoke(), original);
    assert.deepEqual(await statuses("project"), []);
    await assert.rejects(async () => invoke("missing"), /Unknown project/);
    process.env.PASEO_SWARM_PWA_ROOT = join(home, "missing");
    mkdirSync(dirname(getConfigPath()), { recursive: true });
    writeFileSync(getConfigPath(), "corrupt config");
    assert.deepEqual(await invoke(), original);
    assert.deepEqual(await statuses("project"), []);
    const source = join(home, "agreement");
    mkdirSync(join(source, "roles"), { recursive: true });
    writeFileSync(
      join(source, "PWA.md"),
      "---\nversion: 1\nproject: Board\nstatuses: [survey, completed]\n---\nWork.\n",
    );
    writeFileSync(
      join(source, "roles", "director.md"),
      "---\nversion: 1\nroleClass: planner\n---\nDirect.\n",
    );
    const swarm = await createSwarm({ sourceDirectory: source, projectId: "project" });
    assert.deepEqual(await statuses("project"), ["survey", "completed"]);
    writeFileSync(
      join(swarm.directory, "PWA.md"),
      "---\nversion: 1\nproject: Board\nstatuses: [done]\n---\nWork.\n",
    );
    assert.deepEqual(await statuses("project"), ["survey", "completed"]);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  }
});

test("roster reads filter native availability without releasing historical names", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-roster-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const timestamp = "2026-10-06T00:00:00Z";
  const agent: AgentRecord = {
    id: "record",
    paseoAgentId: "native-id",
    name: "historical",
    qualifiedName: "historical",
    aliases: [],
    roleClass: "planner",
    role: "planner",
    reportsTo: null,
    workspaceId: "workspace",
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  let available = false;
  let fail = false;
  const cursors: Array<string | undefined> = [];
  const context = {
    paseo: {
      agents: {
        async list(options: { filter: { includeArchived: boolean }; page: { cursor?: string } }) {
          assert.equal(options.filter.includeArchived, false);
          if (fail) throw new Error("daemon unavailable");
          cursors.push(options.page.cursor);
          return options.page.cursor
            ? {
                entries: available ? [{ agent: { id: agent.paseoAgentId } }] : [],
                pageInfo: { nextCursor: null },
              }
            : { entries: [{ agent: { id: "unregistered" } }], pageInfo: { nextCursor: "next" } };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const invoke = (rpc: typeof boardReadRpc | typeof createSeatRpc, input: unknown) =>
    handlers.get(rpc.name)!(rpc.input.parse(input) as never, context);
  try {
    await seed({ ...emptyState(), agents: [agent] });
    const before = readDisk();
    assert.deepEqual(boardReadRpc.output.parse(await invoke(boardReadRpc, {})).agents, []);
    assert.deepEqual(cursors, [undefined, "next"]);
    await assert.rejects(
      async () =>
        invoke(createSeatRpc, {
          name: "historical",
          roleClass: "planner",
          role: "planner",
          provider: "codex/gpt-6.1-sol",
        }),
      /already exists/,
    );
    available = true;
    const [seated] = store.read().agents;
    assert.ok(seated.swarmId);
    assert.deepEqual(boardReadRpc.output.parse(await invoke(boardReadRpc, {})).agents, [
      { ...seated, pending: null },
    ]);
    available = false;
    assert.deepEqual(boardReadRpc.output.parse(await invoke(boardReadRpc, {})).agents, []);
    fail = true;
    await assert.rejects(async () => invoke(boardReadRpc, {}), /daemon unavailable/);
    assert.equal(readDisk(), before);
    assert.deepEqual(store.read().agents, [seated]);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("manager can replace a Task worker roster with creation-time validation", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-task-workers-"));
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  const timestamp = "2026-10-06T00:00:00Z";
  const planner: AgentRecord = {
    id: "planner-record",
    paseoAgentId: "planner-agent",
    name: "planner",
    qualifiedName: "planner",
    aliases: [],
    roleClass: "planner",
    role: "planner",
    reportsTo: null,
    workspaceId: null,
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const manager: AgentRecord = {
    id: "manager-record",
    paseoAgentId: "manager-agent",
    name: "manager",
    qualifiedName: "planner.manager",
    aliases: [],
    roleClass: "supervisor",
    role: "supervisor",
    reportsTo: "planner",
    workspaceId: null,
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const worker = (name: string, id: string, reportsTo = "planner.manager"): AgentRecord => ({
    id,
    paseoAgentId: `${id}-agent`,
    name,
    qualifiedName: `${reportsTo}.${name}`,
    aliases: [],
    roleClass: "worker",
    role: "researcher",
    reportsTo,
    workspaceId: null,
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  const invoke = (name: string, input: unknown) =>
    handlers.get(name)!(input as never, {} as PluginHandlerContext);
  try {
    await seed({
      ...emptyState(),
      agents: [
        planner,
        manager,
        worker("first", "first-record"),
        worker("second", "second-record"),
        worker("audit", "audit-record", "planner.other"),
      ],
    });
    const created = createTaskRpc.output.parse(
      await invoke(
        createTaskRpc.name,
        createTaskRpc.input.parse({
          id: "roster",
          title: "Roster",
          brief: "Roster",
          status: "survey",
          managerName: "manager",
          workerNames: ["first"],
          createdBy: "planner",
          data: {},
        }),
      ),
    );
    assert.deepEqual(created.workerNames, ["planner.manager.first"]);
    const replaced = updateTaskRpc.output.parse(
      await invoke(
        updateTaskRpc.name,
        updateTaskRpc.input.parse({
          taskId: "roster",
          actorName: "manager",
          workerNames: ["second"],
        }),
      ),
    );
    assert.deepEqual(replaced.workerNames, ["planner.manager.second"]);
    await assert.rejects(
      async () =>
        invoke(
          updateTaskRpc.name,
          updateTaskRpc.input.parse({
            taskId: "roster",
            actorName: "manager",
            workerNames: ["manager"],
          }),
        ),
      /Task worker must have role class worker/,
    );
    // A worker on another team, though its local name is unique, is not this manager's to assign.
    await assert.rejects(
      async () =>
        invoke(
          updateTaskRpc.name,
          updateTaskRpc.input.parse({
            taskId: "roster",
            actorName: "manager",
            workerNames: ["audit"],
          }),
        ),
      /Task worker planner\.other\.audit does not report to planner\.manager/,
    );
    assert.deepEqual(store.read().tasks[0].workerNames, ["planner.manager.second"]);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("prompt refresh re-assembles the standing prompt and records the received revision", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-prompt-refresh-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  const source = join(home, "agreement");
  mkdirSync(join(source, "roles"), { recursive: true });
  writeFileSync(join(source, "PWA.md"), "---\nversion: 1\nproject: Refresh\n---\nProject one.\n");
  const writeRole = (body: string, directory = source) =>
    writeFileSync(
      join(directory, "roles", "planner.md"),
      `---\nversion: 1\nroleClass: planner\n---\n${body}\n`,
    );
  writeRole("Role one.");
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = source;
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  registerOperations({
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  });
  const invoke = (name: string, input: unknown) =>
    handlers.get(name)!(input as never, {} as PluginHandlerContext);
  const refresh = async (paseoAgentId: string) =>
    refreshPromptRpc.output.parse(await invoke(refreshPromptRpc.name, { paseoAgentId }));
  try {
    const prepared = (await invoke(
      prepareAgentRpc.name,
      prepareAgentRpc.input.parse({
        name: "lead",
        roleClass: "planner",
        role: "planner",
        brief: "One-time orientation.",
      }),
    )) as { agentId: string; systemPrompt: string; agent: AgentRecord };
    const created = prepared.agent.prompt;
    assert.ok(created);
    assert.match(prepared.systemPrompt, /One-time orientation/);

    const unchanged = await refresh(prepared.agentId);
    assert.equal(unchanged.changed, false);
    assert.equal(unchanged.previousRevision, created.revision);
    assert.equal(unchanged.revision, created.revision);
    assert.match(unchanged.prompt, /^<paseo-swarm-prompt-refresh>\n/);
    assert.match(unchanged.prompt, /nothing changed/);
    assert.match(unchanged.prompt, /<paseo-swarm-system-settings>/);
    assert.match(unchanged.prompt, /Role one\./);
    assert.doesNotMatch(unchanged.prompt, /One-time orientation/);

    // An edit on disk is not accepted, so it reaches no prompt.
    const swarm = swarmOf(prepared.agent);
    writeRole("Role two.", swarm.directory);
    assert.equal((await refresh(prepared.agentId)).changed, false);
    const files = readPwaFiles(swarm.directory);
    await store.commit(() => [
      {
        op: "put",
        collection: "swarms",
        record: { ...swarm, source: { revision: pwaFilesRevision(files), files } },
      },
    ]);
    const changed = await refresh(prepared.agentId);
    assert.equal(changed.changed, true);
    assert.equal(changed.previousRevision, created.revision);
    assert.notEqual(changed.revision, created.revision);
    assert.match(changed.prompt, /supersedes/);
    assert.match(changed.prompt, /Role two\./);
    assert.doesNotMatch(changed.prompt, /Role one\./);
    // The tool only reads: the receipt moves when the reconciler delivers the prompt.
    const receipt = () =>
      store.read().agents.find((agent) => agent.paseoAgentId === prepared.agentId)?.prompt
        ?.revision;
    assert.equal(receipt(), created.revision);
    assert.equal((await refresh(prepared.agentId)).changed, true);

    // An agent registered before revisions were recorded has nothing to compare.
    await seed(
      {
        ...emptyState(),
        agents: [
          {
            id: "legacy-record",
            paseoAgentId: "legacy-agent",
            name: "legacy",
            qualifiedName: "legacy",
            aliases: [],
            roleClass: "planner",
            role: "planner",
            reportsTo: null,
            workspaceId: null,
            retired: false,
            createdAt: "2026-10-06T00:00:00Z",
            updatedAt: "2026-10-06T00:00:00Z",
          },
        ],
      },
      { stamp: false },
    );
    const legacy = await refresh("legacy-agent");
    assert.equal(legacy.previousRevision, null);
    assert.equal(legacy.changed, true);
    assert.equal(
      store.read().agents.find((agent) => agent.paseoAgentId === "legacy-agent")?.prompt,
      undefined,
    );

    await assert.rejects(async () => refresh("missing-agent"), /Unknown active Swarm agent/);
    writeFileSync(join(swarm.directory, "roles", "planner.md"), "invalid");
    assert.equal((await refresh(prepared.agentId)).revision, changed.revision);
    assert.equal(receipt(), created.revision);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  }
});
