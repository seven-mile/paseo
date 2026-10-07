import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { notifyManager, registerOperations } from "../server/operations";
import { getConfigPath, getStatePath, StateStore, store } from "../server/state";
import { emptyState, type AgentRecord } from "../shared/models";
import {
  boardReadRpc,
  createAgentRpc,
  sendMessageRpc,
  appendHumanActivityRpc,
  createTaskRpc,
  updateTaskRpc,
  pwaSourceSetRpc,
  pwaSourceReadRpc,
  pwaRolesReadRpc,
  prepareAgentRpc,
  bindPreparedAgentRpc,
} from "../shared/swarm";

test("children default to the caller workspace, isolated placement preserves roster, and foreign occupants are rejected", async () => {
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
  await store.update((state) => Object.assign(state, seeded));
  const state = store.read();
  const handlers = new Map<string, (input: never, context: PluginHandlerContext) => unknown>();
  const server: Pick<PluginServerContext, "handle"> = {
    handle(contract, handler) {
      handlers.set(contract.name, handler);
    },
  };
  registerOperations(server);
  const sends: Array<{ agentId: string; text: string; options: unknown }> = [];
  const workspaceCreations: unknown[] = [];
  const agentCreations: Array<{ workspaceId: string; parent: string }> = [];
  const runtimeWorkspaces = new Map([[planner.paseoAgentId, "planner-workspace"]]);
  const prompts: string[] = [];
  const workspace = (workspaceId: string) => ({
    async refresh() {
      return { projectId: workspaceId === "other-workspace" ? "other" : "project" };
    },
    agents: {
      async create(creation: {
        agentId: string;
        parent: string;
        config: { systemPrompt: string };
      }) {
        runtimeWorkspaces.set(creation.agentId, workspaceId);
        prompts.push(creation.config.systemPrompt);
        agentCreations.push({ workspaceId, parent: creation.parent });
        return {
          async refresh() {
            return { agent: { workspaceId } };
          },
          async send(text: string, options: unknown) {
            sends.push({ agentId: creation.agentId, text, options });
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
          createAgentRpc.name,
          createAgentRpc.input.parse({
            name: "missing-role",
            roleClass: "supervisor",
            role: "missing",
            actorPaseoAgentId: planner.paseoAgentId,
            reportsTo: "planner",
            brief: "Survey",
          }),
        ),
      /Missing role/,
    );
    await assert.rejects(
      async () =>
        invoke(
          createAgentRpc.name,
          createAgentRpc.input.parse({
            name: "wrong-project",
            roleClass: "supervisor",
            role: "supervisor",
            projectId: "other",
            actorPaseoAgentId: planner.paseoAgentId,
            reportsTo: "planner",
            brief: "Survey",
          }),
        ),
      /selected project/,
    );
    assert.equal(state.agents.length, 1);
    assert.equal(workspaceCreations.length, 0);
    const supervisor = (await invoke(
      createAgentRpc.name,
      createAgentRpc.input.parse({
        name: "supervisor",
        roleClass: "supervisor",
        role: "supervisor",
        actorPaseoAgentId: planner.paseoAgentId,
        reportsTo: "planner",
        provider: "codex/gpt-6.1-sol",
        modeId: "auto-review",
        brief: "Survey",
        workspaceId: "supervisor-workspace",
      }),
    )) as AgentRecord;
    assert.equal(supervisor.workspaceId, "supervisor-workspace");
    assert.deepEqual(workspaceCreations, []);
    const worker = (await invoke(
      createAgentRpc.name,
      createAgentRpc.input.parse({
        name: "scout",
        roleClass: "worker",
        role: "researcher",
        actorPaseoAgentId: supervisor.paseoAgentId,
        reportsTo: "planner.supervisor",
        provider: "codex/gpt-6.1-sol",
        brief: "Survey",
      }),
    )) as AgentRecord;
    assert.equal(worker.workspaceId, supervisor.workspaceId);
    assert.equal(workspaceCreations.length, 0);
    assert.deepEqual(agentCreations, [
      { workspaceId: "supervisor-workspace", parent: planner.paseoAgentId },
      { workspaceId: "supervisor-workspace", parent: supervisor.paseoAgentId },
    ]);
    assert.equal(supervisor.projectId, "project");
    assert.equal(worker.projectId, "project");
    const createChild = (actor: AgentRecord, name: string, workspaceId?: string) =>
      invoke(
        createAgentRpc.name,
        createAgentRpc.input.parse({
          name,
          actorPaseoAgentId: actor.paseoAgentId,
          reportsTo: actor.qualifiedName,
          roleClass: actor.roleClass === "planner" ? "supervisor" : "worker",
          role: actor.roleClass === "planner" ? "supervisor" : "researcher",
          workspaceId,
        }),
      ) as Promise<AgentRecord>;
    const defaultSupervisor = await createChild(planner, "default-supervisor");
    assert.equal(defaultSupervisor.workspaceId, planner.workspaceId);
    const parallel = await createChild(supervisor, "parallel", "parallel-workspace");
    assert.equal(parallel.workspaceId, "parallel-workspace");
    assert.equal(parallel.reportsTo, supervisor.qualifiedName);
    const peer = await createChild(supervisor, "parallel-peer", "parallel-workspace");
    assert.equal(peer.reportsTo, supervisor.qualifiedName);
    const savedCount = state.agents.length;
    const createdCount = agentCreations.length;
    await assert.rejects(
      async () => createChild(planner, "grandchild-conflict", "parallel-workspace"),
      /outside planner's direct roster/,
    );
    await assert.rejects(
      async () => createChild(defaultSupervisor, "sibling-conflict", "parallel-workspace"),
      /outside planner.default-supervisor's direct roster/,
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
    assert.equal(state.agents.length, savedCount);
    assert.equal(agentCreations.length, createdCount);
    const prepareLegacy = (name: string) =>
      invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({ name, roleClass: "planner", role: "planner" }),
      ) as Promise<{ agentId: string; systemPrompt: string; agent: AgentRecord }>;
    const legacyDefault = await prepareLegacy("legacy-default");
    assert.equal(legacyDefault.agent.projectId, undefined);
    runtimeWorkspaces.set(legacyDefault.agentId, "supervisor-workspace");
    await invoke(bindPreparedAgentRpc.name, {
      agentId: legacyDefault.agentId,
      workspaceId: "supervisor-workspace",
    });
    assert.equal(legacyDefault.agent.projectId, "project");
    const legacyOverride = await prepareLegacy("legacy-override");
    runtimeWorkspaces.set(legacyOverride.agentId, "supervisor-workspace");
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
    writeFileSync(
      join(source, "roles", "researcher.md"),
      "---\nversion: 1\nroleClass: worker\n---\nFirst role.\n",
    );
    assert.deepEqual(
      await invoke(pwaSourceSetRpc.name, { projectId: "project", path: "agreement" }),
      { path: source },
    );
    assert.deepEqual(await invoke(pwaSourceReadRpc.name, { projectId: "project" }), {
      path: source,
    });
    const legacyPrompt = legacyOverride.systemPrompt;
    await assert.rejects(
      async () =>
        invoke(bindPreparedAgentRpc.name, {
          agentId: legacyOverride.agentId,
          workspaceId: "supervisor-workspace",
        }),
      /Prepare this agent with the selected project before binding its PWA directory/,
    );
    assert.equal(legacyOverride.agent.workspaceId, null);
    assert.equal(legacyOverride.agent.projectId, undefined);
    assert.equal(legacyOverride.systemPrompt, legacyPrompt);

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
    writeFileSync(
      join(source, "PWA.md"),
      "---\nversion: 1\nproject: Override\nstatuses: [review, survey, completed]\n---\nFresh project.\n",
    );
    const readStatuses = async () =>
      boardReadRpc.output.parse(await invoke(boardReadRpc.name, { projectId: "project" })).statuses;
    assert.deepEqual(await readStatuses(), ["review", "survey", "completed"]);
    writeFileSync(
      join(source, "PWA.md"),
      "---\nversion: 1\nproject: Override\nstatuses: [completed, review]\n---\nFresh project.\n",
    );
    assert.deepEqual(await readStatuses(), ["completed", "review"]);
    assert.equal("statuses" in state, false);
    assert.deepEqual(await invoke(boardReadRpc.name, {}), state);
    const prepare = (name: string) =>
      invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({
          name,
          roleClass: "worker",
          role: "researcher",
          reportsTo: "planner.supervisor",
        }),
      ) as Promise<{ agentId: string; systemPrompt: string; agent: AgentRecord }>;
    const first = await prepare("fresh-one");
    assert.match(first.systemPrompt, /Fresh project/);
    assert.match(first.systemPrompt, /First role/);
    writeFileSync(
      join(source, "roles", "researcher.md"),
      "---\nversion: 1\nroleClass: worker\n---\nSecond role.\n",
    );
    const second = await prepare("fresh-two");
    assert.match(second.systemPrompt, /Second role/);
    assert.doesNotMatch(first.systemPrompt, /Second role/);
    assert.doesNotMatch(prompts[1], /Fresh project/);
    const count = state.agents.length;
    writeFileSync(join(source, "roles", "researcher.md"), "invalid");
    await assert.rejects(async () => prepare("invalid-preparation"), /YAML frontmatter/);
    assert.equal(state.agents.length, count);
    runtimeWorkspaces.set(first.agentId, "other-workspace");
    await assert.rejects(
      async () =>
        invoke(bindPreparedAgentRpc.name, {
          agentId: first.agentId,
          workspaceId: "other-workspace",
        }),
      /selected project/,
    );
    assert.equal(first.agent.workspaceId, null);
    runtimeWorkspaces.set(first.agentId, "supervisor-workspace");
    await invoke(bindPreparedAgentRpc.name, {
      agentId: first.agentId,
      workspaceId: "supervisor-workspace",
    });
    assert.equal(first.agent.workspaceId, "supervisor-workspace");
    const initialSends = sends.length;
    await notifyManager(
      { id: worker.paseoAgentId },
      "completed",
      "turn completed",
      "Findings",
      context,
    );
    await invoke(
      sendMessageRpc.name,
      sendMessageRpc.input.parse({
        senderName: "planner.supervisor.scout",
        recipientName: "planner.supervisor",
        recipientPaseoAgentId: supervisor.paseoAgentId,
        body: "Survey findings",
      }),
    );
    state.tasks.push({
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
    });
    await invoke(
      appendHumanActivityRpc.name,
      appendHumanActivityRpc.input.parse({
        taskId: "survey",
        actorName: "human",
        kind: "decision",
        body: "Continue",
      }),
    );
    assert.equal(sends.length, initialSends + 3);
    for (const delivery of sends.slice(initialSends)) {
      assert.equal(delivery.agentId, supervisor.paseoAgentId);
      assert.deepEqual(delivery.options, { activeTurnBehavior: "steer" });
    }
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
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
    await store.update((state) => Object.assign(state, seeded));
    const saved = appendHumanActivityRpc.output.parse(await invoke());
    assert.equal(saved.notificationWarning, "Manager is offline");
    assert.equal(sends, 1);
    const persisted = new StateStore().read();
    assert.equal(persisted.activities.length, 1);
    assert.equal(persisted.activities[0].id, saved.id);
    assert.equal("notificationWarning" in persisted.activities[0], false);
    await store.update((state) => {
      state.agents = [];
    });
    const missing = appendHumanActivityRpc.output.parse(await invoke());
    assert.match(missing.notificationWarning!, /Unknown active agent/);
    assert.equal(new StateStore().read().activities.length, 2);
    const diskBefore = readFileSync(getStatePath(), "utf8");
    const blocked = join(home, "not-a-directory");
    writeFileSync(blocked, "file");
    process.env.PASEO_HOME = blocked;
    await assert.rejects(async () => invoke(), /ENOTDIR/);
    process.env.PASEO_HOME = home;
    assert.equal(readFileSync(getStatePath(), "utf8"), diskBefore);
    assert.equal(sends, 1);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test("plain board reads bypass absent or corrupt sources; project reads resolve PWA statuses", async () => {
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
    await store.update((state) => Object.assign(state, emptyState()));
    const original = store.read();
    assert.deepEqual(await invoke(), original);
    assert.deepEqual(boardReadRpc.output.parse(await invoke("project")).statuses, []);
    await assert.rejects(async () => invoke("missing"), /Unknown project/);
    process.env.PASEO_SWARM_PWA_ROOT = join(home, "missing");
    assert.deepEqual(await invoke(), original);
    await assert.rejects(async () => invoke("project"), /ENOENT/);
    writeFileSync(getConfigPath(), "corrupt config");
    assert.deepEqual(await invoke(), original);
    await assert.rejects(async () => invoke("project"), SyntaxError);
    writeFileSync(getConfigPath(), JSON.stringify({ pwaRoot: home }));
    mkdirSync(join(home, "roles"));
    writeFileSync(
      join(home, "roles", "developer.md"),
      "---\nversion: 1\nroleClass: worker\n---\nDevelop.\n",
    );
    await assert.rejects(async () => invoke("project"), /must contain a planner role/);
    assert.deepEqual(await invoke(), original);
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
  const invoke = (rpc: typeof boardReadRpc | typeof createAgentRpc, input: unknown) =>
    handlers.get(rpc.name)!(rpc.input.parse(input) as never, context);
  try {
    await store.update((state) => Object.assign(state, { ...emptyState(), agents: [agent] }));
    const before = readFileSync(getStatePath(), "utf8");
    assert.deepEqual(boardReadRpc.output.parse(await invoke(boardReadRpc, {})).agents, []);
    assert.deepEqual(cursors, [undefined, "next"]);
    await assert.rejects(
      async () =>
        invoke(createAgentRpc, {
          name: "historical",
          roleClass: "planner",
          role: "planner",
        }),
      /already exists/,
    );
    available = true;
    assert.deepEqual(boardReadRpc.output.parse(await invoke(boardReadRpc, {})).agents, [agent]);
    available = false;
    assert.deepEqual(boardReadRpc.output.parse(await invoke(boardReadRpc, {})).agents, []);
    fail = true;
    await assert.rejects(async () => invoke(boardReadRpc, {}), /daemon unavailable/);
    assert.equal(readFileSync(getStatePath(), "utf8"), before);
    assert.deepEqual(store.read().agents, [agent]);
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
  const worker = (name: string, id: string): AgentRecord => ({
    id,
    paseoAgentId: `${id}-agent`,
    name,
    qualifiedName: `planner.manager.${name}`,
    aliases: [],
    roleClass: "worker",
    role: "researcher",
    reportsTo: "planner.manager",
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
    await store.update((state) => {
      Object.assign(state, emptyState());
      state.agents.push(
        planner,
        manager,
        worker("first", "first-record"),
        worker("second", "second-record"),
      );
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
    assert.deepEqual(store.read().tasks[0].workerNames, ["planner.manager.second"]);
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
