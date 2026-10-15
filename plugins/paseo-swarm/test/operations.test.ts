import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type {
  PluginHandlerContext,
  PluginHookContext,
  PluginLifecycleEvents,
  PluginServerContext,
} from "@getpaseo/plugin/server";
import contribute from "../index.server";
import { notifyManager, registerOperations } from "../server/operations";
import { getConfigPath, getStatePath, StateStore, store } from "../server/state";
import { emptyState, type AgentRecord } from "../shared/models";
import {
  boardReadRpc,
  createAgentRpc,
  sendMessageRpc,
  appendHumanActivityRpc,
  appendActivityRpc,
  createTaskRpc,
  updateTaskRpc,
  pwaSourceSetRpc,
  pwaSourceReadRpc,
  pwaRolesReadRpc,
  prepareAgentRpc,
  bindPreparedAgentRpc,
  bindPwaRpc,
  registerAgentRpc,
} from "../shared/swarm";

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
    projectId: "project",
    pwaBinding: {
      projectId: "project",
      contentRoot: process.env.PASEO_SWARM_PWA_ROOT!,
      directory: process.env.PASEO_SWARM_PWA_ROOT!,
    },
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
  const runtimeParents = new Map<string, string>();
  let beforeRosterList: (() => Promise<void>) | undefined;
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
        if (workspaceId === "failing-workspace") throw new Error("Native creation unavailable");
        runtimeWorkspaces.set(creation.agentId, workspaceId);
        runtimeParents.set(creation.agentId, creation.parent);
        prompts.push(creation.config.systemPrompt);
        agentCreations.push({ workspaceId, parent: creation.parent });
        return {
          async refresh() {
            return { agent: { workspaceId, labels: { "paseo.parent-agent-id": creation.parent } } };
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
          const beforeList = beforeRosterList;
          beforeRosterList = undefined;
          if (beforeList) await beforeList();
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
                agent: {
                  cwd: "/test/project",
                  workspaceId: runtimeWorkspaces.get(agentId),
                  labels: runtimeParents.has(agentId)
                    ? { "paseo.parent-agent-id": runtimeParents.get(agentId) }
                    : {},
                },
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
            workspaceId: "supervisor-workspace",
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
    const placementError =
      /Prepare a separate workspace for the supervisor and pass its workspaceId/;
    for (const workspaceId of [undefined, null, "planner-workspace"]) {
      await assert.rejects(
        async () =>
          invoke(
            createAgentRpc.name,
            createAgentRpc.input.parse({
              name: "invalid-placement",
              roleClass: "supervisor",
              role: "supervisor",
              actorPaseoAgentId: planner.paseoAgentId,
              reportsTo: "planner",
              workspaceId,
            }),
          ),
        placementError,
      );
      assert.equal(state.agents.length, 1);
      assert.equal(agentCreations.length, 0);
    }
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
    const savedCount = state.agents.length;
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
    assert.equal(state.agents.length, savedCount);
    assert.equal(agentCreations.length, createdCount);
    const reservationsBeforeFailure = state.agents.length;
    const sendsBeforeFailure = sends.length;
    await assert.rejects(
      async () => createChild(supervisor, "creation-failure", "failing-workspace"),
      /Reservation .* retained/,
    );
    assert.equal(state.agents.length, reservationsBeforeFailure + 1);
    const reservation = state.agents.find((entry) => entry.name === "creation-failure");
    assert.equal(reservation?.creationError, "Native creation unavailable");
    assert.equal(reservation?.workspaceId, null);
    await assert.rejects(
      async () =>
        invoke(
          registerAgentRpc.name,
          registerAgentRpc.input.parse({
            paseoAgentId: reservation!.paseoAgentId,
            name: "creation-failure",
            roleClass: "worker",
            role: "researcher",
            reportsTo: supervisor.qualifiedName,
          }),
        ),
      /bind_workspace/,
    );
    assert.equal(sends.length, sendsBeforeFailure);
    await assert.rejects(
      async () => createChild(supervisor, "creation-failure", "failing-workspace"),
      /already exists/,
    );
    assert.equal(state.agents.length, reservationsBeforeFailure + 1);
    await assert.rejects(
      async () =>
        invoke(
          prepareAgentRpc.name,
          prepareAgentRpc.input.parse({
            name: "implicit-default",
            roleClass: "planner",
            role: "planner",
            projectId: "project",
          }),
        ),
      /Choose a PWA directory explicitly/,
    );
    const preparedRoot = prepareAgentRpc.output.parse(
      await invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({
          name: "prepared-root",
          roleClass: "planner",
          role: "planner",
          projectId: "project",
          pwaDirectory: ".",
        }),
      ),
    );
    assert.equal(preparedRoot.parentAgentId, null);
    const preparedBinding = { ...preparedRoot.agent.pwaBinding };
    const preparedPrompt = preparedRoot.systemPrompt;
    const originalBinding = { ...planner.pwaBinding };
    const source = join(home, "agreement");
    mkdirSync(join(source, "roles"), { recursive: true });
    const agreement = (statuses: string) =>
      `---\nversion: 1\nproject: Override\nstatuses: [${statuses}]\nroles:\n  planner: roles/director.md\n  director: roles/director.md\n  supervisor: roles/supervisor.md\n  researcher: roles/researcher.md\n---\nFresh project.\n`;
    writeFileSync(join(source, "PWA.md"), agreement("review, survey, completed"));
    writeFileSync(
      join(source, "roles", "director.md"),
      "---\nversion: 1\nroleClass: planner\n---\nDirect.\n",
    );
    writeFileSync(
      join(source, "roles", "supervisor.md"),
      "---\nversion: 1\nroleClass: supervisor\n---\nSupervise.\n",
    );
    writeFileSync(
      join(source, "roles", "researcher.md"),
      "---\nversion: 1\nroleClass: worker\n---\nFirst role.\n",
    );
    assert.deepEqual(
      await invoke(pwaSourceSetRpc.name, {
        projectId: "project",
        path: "agreement",
        defaultPwa: ".",
      }),
      { path: source, defaultPwa: "." },
    );
    const discovery = pwaSourceReadRpc.output.parse(
      await invoke(pwaSourceReadRpc.name, { projectId: "project" }),
    );
    assert.equal(discovery.path, source);
    assert.equal(discovery.defaultPwa, ".");
    assert.equal(discovery.complete, true);
    assert.deepEqual(discovery.errors, []);
    assert.deepEqual(
      discovery.entries.map((entry) => entry.directory),
      ["."],
    );
    assert.deepEqual(planner.pwaBinding, originalBinding);
    assert.deepEqual(supervisor.pwaBinding, originalBinding);
    assert.deepEqual(preparedRoot.agent.pwaBinding, preparedBinding);
    assert.equal(preparedRoot.systemPrompt, preparedPrompt);
    const inherited = prepareAgentRpc.output.parse(
      await invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({
          name: "unchanged-source",
          roleClass: "worker",
          role: "researcher",
          reportsTo: supervisor.qualifiedName,
        }),
      ),
    );
    assert.doesNotMatch(inherited.systemPrompt, /Fresh project/);
    const inheritedId = inherited.agentId;
    const inheritedPrompt = inherited.systemPrompt;
    const inheritedBinding = { ...inherited.agent.pwaBinding };
    await assert.rejects(
      async () => invoke(pwaSourceSetRpc.name, { projectId: "missing", path: source }),
      /Unknown project/,
    );
    const choices = pwaRolesReadRpc.output.parse(
      await invoke(pwaRolesReadRpc.name, {
        projectId: "project",
        path: ".",
        roleClass: "planner",
      }),
    );
    assert.deepEqual(
      choices.map((role) => role.role),
      ["director", "planner"],
    );
    // Only explicit confirmation moves the manager to the new directory.
    await invoke(
      bindPwaRpc.name,
      bindPwaRpc.input.parse({ agentName: planner.qualifiedName, pwaDirectory: "." }),
    );
    assert.deepEqual(supervisor.pwaBinding, originalBinding);
    await invoke(
      bindPwaRpc.name,
      bindPwaRpc.input.parse({ agentName: supervisor.qualifiedName, pwaDirectory: "." }),
    );
    runtimeWorkspaces.set(inheritedId, "supervisor-workspace");
    runtimeParents.set(inheritedId, supervisor.paseoAgentId);
    await assert.rejects(
      async () =>
        invoke(bindPreparedAgentRpc.name, {
          agentId: inheritedId,
          workspaceId: "supervisor-workspace",
        }),
      /manager's PWA binding changed after preparation/,
    );
    const retained = state.agents.find((entry) => entry.paseoAgentId === inheritedId);
    assert.deepEqual(retained, inherited.agent);
    assert.equal(retained?.workspaceId, null);
    assert.equal(inherited.agentId, inheritedId);
    assert.equal(inherited.systemPrompt, inheritedPrompt);
    assert.deepEqual(retained?.pwaBinding, inheritedBinding);
    const readStatuses = async () =>
      boardReadRpc.output.parse(
        await invoke(boardReadRpc.name, {
          projectId: "project",
          teamName: planner.qualifiedName,
        }),
      ).statuses;
    assert.deepEqual(await readStatuses(), ["review", "survey", "completed"]);
    writeFileSync(join(source, "PWA.md"), agreement("completed, review"));
    assert.deepEqual(await readStatuses(), ["completed", "review"]);
    assert.equal("statuses" in state, false);
    const plainBoard = boardReadRpc.output.parse(await invoke(boardReadRpc.name, {}));
    assert.deepEqual(plainBoard.tasks, state.tasks);
    assert.deepEqual(plainBoard.activities, state.activities);
    assert.equal(plainBoard.statuses, undefined);
    const prepare = (name: string) =>
      invoke(
        prepareAgentRpc.name,
        prepareAgentRpc.input.parse({
          name,
          roleClass: "worker",
          role: "researcher",
          reportsTo: supervisor.qualifiedName,
        }),
      ) as Promise<{
        agentId: string;
        systemPrompt: string;
        parentAgentId: string;
        agent: AgentRecord;
      }>;
    const first = await prepare("fresh-one");
    assert.equal(first.parentAgentId, supervisor.paseoAgentId);
    assert.match(first.systemPrompt, /Fresh project/);
    assert.match(first.systemPrompt, /First role/);
    const firstPrompt = first.systemPrompt;
    writeFileSync(
      join(source, "roles", "researcher.md"),
      "---\nversion: 1\nroleClass: worker\n---\nSecond role.\n",
    );
    const second = await prepare("fresh-two");
    assert.match(second.systemPrompt, /Second role/);
    assert.equal(first.systemPrompt, firstPrompt);
    assert.doesNotMatch(prompts[1], /Fresh project/);
    const count = state.agents.length;
    writeFileSync(join(source, "roles", "researcher.md"), "invalid");
    await assert.rejects(async () => prepare("invalid-preparation"), /YAML frontmatter/);
    assert.equal(state.agents.length, count);
    writeFileSync(
      join(source, "roles", "researcher.md"),
      "---\nversion: 1\nroleClass: worker\n---\nThird role.\n",
    );
    runtimeParents.set(first.agentId, supervisor.paseoAgentId);
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
    runtimeParents.set(first.agentId, planner.paseoAgentId);
    await assert.rejects(
      async () =>
        invoke(bindPreparedAgentRpc.name, {
          agentId: first.agentId,
          workspaceId: "supervisor-workspace",
        }),
      /parent does not match/,
    );
    runtimeParents.set(first.agentId, supervisor.paseoAgentId);
    await assert.rejects(
      async () =>
        invoke(
          registerAgentRpc.name,
          registerAgentRpc.input.parse({
            paseoAgentId: first.agentId,
            name: "fresh-one",
            roleClass: "worker",
            role: "researcher",
            reportsTo: supervisor.qualifiedName,
            workspaceId: "supervisor-workspace",
          }),
        ),
      /bind_workspace/,
    );
    await assert.rejects(
      async () =>
        invoke(
          bindPwaRpc.name,
          bindPwaRpc.input.parse({
            agentName: first.agent.qualifiedName,
            pwaDirectory: ".",
          }),
        ),
      /Finish binding the prepared agent/,
    );
    assert.equal(first.agent.workspaceId, null);
    assert.equal(first.systemPrompt, firstPrompt);
    const firstBinding = { ...first.agent.pwaBinding };
    const parentBindingBeforeConfigChange = { ...supervisor.pwaBinding };
    await invoke(pwaSourceSetRpc.name, {
      projectId: "project",
      path: originalBinding.contentRoot,
      defaultPwa: ".",
    });
    assert.deepEqual(supervisor.pwaBinding, parentBindingBeforeConfigChange);
    assert.deepEqual(first.agent.pwaBinding, firstBinding);
    const sendsBeforeBind = sends.length;
    const creationsBeforeBind = agentCreations.length;
    await invoke(bindPreparedAgentRpc.name, {
      agentId: first.agentId,
      workspaceId: "supervisor-workspace",
    });
    assert.equal(first.agent.workspaceId, "supervisor-workspace");
    assert.equal(first.systemPrompt, firstPrompt);
    assert.doesNotMatch(first.systemPrompt, /Third role/);
    assert.equal(sends.length, sendsBeforeBind);
    assert.equal(agentCreations.length, creationsBeforeBind);
    const interleaved = await prepare("interleaved-binding");
    const interleavedId = interleaved.agentId;
    const interleavedPrompt = interleaved.systemPrompt;
    const interleavedBinding = { ...interleaved.agent.pwaBinding };
    runtimeWorkspaces.set(interleavedId, "supervisor-workspace");
    runtimeParents.set(interleavedId, supervisor.paseoAgentId);
    let changedDuringRosterRead = false;
    beforeRosterList = async () => {
      assert.deepEqual(supervisor.pwaBinding, interleavedBinding);
      await invoke(
        bindPwaRpc.name,
        bindPwaRpc.input.parse({
          agentName: planner.qualifiedName,
          pwaDirectory: ".",
        }),
      );
      await invoke(
        bindPwaRpc.name,
        bindPwaRpc.input.parse({
          agentName: supervisor.qualifiedName,
          pwaDirectory: ".",
        }),
      );
      assert.deepEqual(supervisor.pwaBinding, originalBinding);
      changedDuringRosterRead = true;
    };
    const countBeforeInterleavedBind = state.agents.length;
    const sendsBeforeInterleavedBind = sends.length;
    await assert.rejects(
      async () =>
        invoke(bindPreparedAgentRpc.name, {
          agentId: interleavedId,
          workspaceId: "supervisor-workspace",
        }),
      /manager's PWA binding changed after preparation/,
    );
    assert.equal(changedDuringRosterRead, true);
    assert.equal(beforeRosterList, undefined);
    assert.equal(state.agents.length, countBeforeInterleavedBind);
    assert.deepEqual(
      state.agents.find((entry) => entry.paseoAgentId === interleavedId),
      interleaved.agent,
    );
    assert.equal(interleaved.agentId, interleavedId);
    assert.equal(interleaved.agent.workspaceId, null);
    assert.deepEqual(interleaved.agent.pwaBinding, interleavedBinding);
    assert.equal(interleaved.systemPrompt, interleavedPrompt);
    assert.equal(sends.length, sendsBeforeInterleavedBind);
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
    await assert.rejects(
      async () =>
        invoke(
          sendMessageRpc.name,
          sendMessageRpc.input.parse({
            senderName: "planner.supervisor.scout",
            recipientName: "planner.supervisor",
            recipientPaseoAgentId: worker.paseoAgentId,
            body: "Mismatched recipient",
          }),
        ),
      /does not match agent/,
    );
    await assert.rejects(
      async () =>
        invoke(
          sendMessageRpc.name,
          sendMessageRpc.input.parse({
            senderName: "planner.supervisor.scout",
            recipientName: "missing",
            recipientPaseoAgentId: "missing-agent",
            body: "Unknown recipient",
          }),
        ),
      /Unknown active Swarm recipient/,
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
    await assert.rejects(
      async () =>
        invoke(
          sendMessageRpc.name,
          sendMessageRpc.input.parse({
            senderName: "planner.supervisor.scout",
            actorName: "planner.supervisor.scout",
            recipientName: "planner.supervisor.scout",
            recipientPaseoAgentId: worker.paseoAgentId,
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
    await store.update((state) =>
      Object.assign(state, { ...emptyState(), agents: [manager, worker] }),
    );
    contribute(server as PluginServerContext);
    assert.deepEqual([...hooks.keys()], ["agent.turn_ended"]);
    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        sends.length = 0;
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
          [{ agentId: manager.paseoAgentId, options: { activeTurnBehavior: "steer" } }],
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

test("team boards use manager ancestry and confirmed PWA bindings while legacy records remain usable", async () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-board-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  delete process.env.PASEO_SWARM_PWA_ROOT;
  const timestamp = "2026-10-06T00:00:00Z";
  const writeAgreement = (directory: string, statuses: string) => {
    mkdirSync(join(directory, "roles"), { recursive: true });
    writeFileSync(
      join(directory, "PWA.md"),
      `---\nversion: 1\nproject: Team\nstatuses: [${statuses}]\nroles:\n  planner: roles/planner.md\n  supervisor: roles/supervisor.md\n  researcher: roles/researcher.md\n---\nTeam agreement.\n`,
    );
    for (const [role, roleClass] of [
      ["planner", "planner"],
      ["supervisor", "supervisor"],
      ["researcher", "worker"],
    ]) {
      writeFileSync(
        join(directory, "roles", `${role}.md`),
        `---\nversion: 1\nroleClass: ${roleClass}\n---\n${role}.\n`,
      );
    }
  };
  const directoryA = join(home, "a");
  const directoryB = join(home, "b");
  writeAgreement(directoryA, "todo, done");
  writeAgreement(directoryB, "queued, released");
  const binding = (directory: string) => ({ projectId: "project", contentRoot: home, directory });
  const agent = (
    name: string,
    roleClass: AgentRecord["roleClass"],
    reportsTo: string | null,
  ): AgentRecord => ({
    id: `${name}-record`,
    paseoAgentId: `${name}-native`,
    name,
    qualifiedName: reportsTo ? `${reportsTo}.${name}` : name,
    aliases: [],
    roleClass,
    role: roleClass === "worker" ? "researcher" : roleClass,
    reportsTo,
    workspaceId: null,
    projectId: "project",
    retired: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const plannerA = { ...agent("a", "planner", null), pwaBinding: binding(directoryA) };
  const plannerB = { ...agent("b", "planner", null), pwaBinding: binding(directoryB) };
  const managerA = agent("manager-a", "supervisor", "a");
  const managerB = agent("manager-b", "supervisor", "b");
  const legacy = agent("legacy", "planner", null);
  const agents = [plannerA, plannerB, managerA, managerB, legacy];
  const nativeWorkspaces = new Map<string, string | null>(
    agents.map((entry) => [entry.paseoAgentId, entry.workspaceId]),
  );
  const nativeParents = new Map<string, string>();
  const unavailable = new Set<string>();
  const deliveries: string[] = [];
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
          return {
            entries: agents
              .filter((entry) => !unavailable.has(entry.paseoAgentId))
              .map((entry) => ({ agent: { id: entry.paseoAgentId } })),
            pageInfo: { nextCursor: null },
          };
        },
        ref(agentId: string) {
          return {
            async refresh() {
              return nativeWorkspaces.has(agentId)
                ? {
                    agent: {
                      id: agentId,
                      workspaceId: nativeWorkspaces.get(agentId),
                      labels: nativeParents.has(agentId)
                        ? { "paseo.parent-agent-id": nativeParents.get(agentId) }
                        : {},
                    },
                  }
                : null;
            },
            async send(text: string) {
              deliveries.push(`${agentId}:${text}`);
            },
          };
        },
      },
      projects: {
        async list() {
          return { projects: [{ projectId: "project", projectRootPath: home }] };
        },
      },
      workspaces: {
        ref() {
          return {
            async refresh() {
              return { projectId: "project" };
            },
          };
        },
      },
    },
  } as unknown as PluginHandlerContext;
  const invoke = (name: string, input: unknown) => handlers.get(name)!(input as never, context);
  const board = async (input: unknown) =>
    boardReadRpc.output.parse(await invoke(boardReadRpc.name, input));
  try {
    await store.update((state) => Object.assign(state, { ...emptyState(), agents }));
    const task = createTaskRpc.output.parse(
      await invoke(
        createTaskRpc.name,
        createTaskRpc.input.parse({
          id: "cross-created",
          title: "Cross-created",
          brief: "Keep raw status",
          status: "legacy-status",
          managerName: managerB.qualifiedName,
          createdBy: plannerA.qualifiedName,
        }),
      ),
    );
    assert.equal(task.managerName, managerB.qualifiedName);
    assert.equal(task.createdBy, plannerA.qualifiedName);
    const entrances = await board({ projectId: "project" });
    assert.deepEqual(entrances.tasks, []);
    assert.deepEqual(entrances.activities, []);
    assert.deepEqual(entrances.statuses, []);
    assert.deepEqual(
      entrances.agents.map((entry) => entry.qualifiedName),
      ["a", "b", "legacy"],
    );
    const teamA = await board({ projectId: "project", teamName: "a" });
    const teamB = await board({ projectId: "project", teamName: "b" });
    assert.deepEqual(teamA.statuses, ["todo", "done"]);
    assert.deepEqual(teamA.tasks, []);
    assert.deepEqual(teamB.statuses, ["queued", "released"]);
    assert.deepEqual(teamB.tasks, [task]);
    assert.deepEqual((await board({ teamName: managerB.qualifiedName })).tasks, [task]);
    await invoke(pwaSourceSetRpc.name, { projectId: "project", path: home, defaultPwa: "a" });
    assert.deepEqual(plannerB.pwaBinding, binding(directoryB));
    assert.deepEqual((await board({ teamName: "b" })).statuses, ["queued", "released"]);
    writeAgreement(directoryB, "released, archived");
    const changed = await board({ teamName: "b" });
    assert.deepEqual(changed.statuses, ["released", "archived"]);
    assert.equal(changed.tasks[0].status, "legacy-status");
    unavailable.add(managerB.paseoAgentId);
    rmSync(directoryB, { recursive: true });
    const broken = await board({ projectId: "project", teamName: "b" });
    assert.deepEqual(broken.tasks, [task]);
    assert.deepEqual(broken.statuses, []);
    assert.ok(broken.pwaError);
    assert.deepEqual(store.read().tasks, [task]);
    assert.deepEqual((await board({})).tasks, [task]);
    // A broken sibling is reported without hiding the valid discovered agreement.
    mkdirSync(directoryB);
    writeFileSync(join(directoryB, "PWA.md"), "broken");
    const discovered = pwaSourceReadRpc.output.parse(
      await invoke(pwaSourceReadRpc.name, { projectId: "project" }),
    );
    assert.ok(discovered.entries.some((entry) => entry.directory === "a" && !entry.error));
    assert.ok(discovered.entries.some((entry) => entry.directory === "b" && entry.error));
    assert.deepEqual(discovered.errors, []);
    const legacyBoard = await board({ teamName: "legacy" });
    assert.ok(legacyBoard.pwaError);
    await invoke(
      sendMessageRpc.name,
      sendMessageRpc.input.parse({
        senderName: "legacy",
        recipientName: "a",
        recipientPaseoAgentId: plannerA.paseoAgentId,
        body: "Existing legacy agent still communicates",
      }),
    );
    assert.equal(deliveries.length, 1);
    const legacyTask = createTaskRpc.output.parse(
      await invoke(
        createTaskRpc.name,
        createTaskRpc.input.parse({
          id: "legacy-record",
          title: "Existing work",
          brief: "No PWA required for records",
          status: "old",
          managerName: "legacy",
          createdBy: "legacy",
        }),
      ),
    );
    await invoke(
      updateTaskRpc.name,
      updateTaskRpc.input.parse({ taskId: legacyTask.id, actorName: "legacy", status: "custom" }),
    );
    assert.equal((await board({ teamName: "legacy" })).tasks[0].status, "custom");
    const child = {
      name: "new-manager",
      roleClass: "supervisor",
      role: "supervisor",
      reportsTo: "legacy",
      pwaDirectory: "a",
    };
    await assert.rejects(
      async () => invoke(prepareAgentRpc.name, prepareAgentRpc.input.parse(child)),
      /Confirm the manager's PWA directory/,
    );
    assert.equal(legacy.pwaBinding, undefined);
    await assert.rejects(
      async () =>
        invoke(
          bindPwaRpc.name,
          bindPwaRpc.input.parse({
            agentName: "legacy",
            pwaDirectory: "a",
          }),
        ),
      /Finish binding the prepared agent/,
    );
    nativeWorkspaces.set(legacy.paseoAgentId, "legacy-native-workspace");
    const recovered = registerAgentRpc.output.parse(
      await invoke(
        registerAgentRpc.name,
        registerAgentRpc.input.parse({
          paseoAgentId: legacy.paseoAgentId,
          name: "legacy",
          roleClass: "planner",
          role: "planner",
          workspaceId: "legacy-native-workspace",
          projectId: "project",
        }),
      ),
    );
    assert.equal(recovered.workspaceId, "legacy-native-workspace");
    assert.equal(recovered.pwaBinding, undefined);
    const confirmed = bindPwaRpc.output.parse(
      await invoke(
        bindPwaRpc.name,
        bindPwaRpc.input.parse({
          agentName: "legacy",
          pwaDirectory: "a",
        }),
      ),
    );
    assert.deepEqual(confirmed.pwaBinding, binding(directoryA));
    const prepared = prepareAgentRpc.output.parse(
      await invoke(prepareAgentRpc.name, prepareAgentRpc.input.parse(child)),
    );
    assert.deepEqual(prepared.agent.pwaBinding, binding(directoryA));
    assert.equal(prepared.parentAgentId, legacy.paseoAgentId);
    writeAgreement(directoryB, "queued, released");
    await assert.rejects(
      async () =>
        invoke(
          prepareAgentRpc.name,
          prepareAgentRpc.input.parse({
            ...child,
            name: "conflicting-child",
            pwaDirectory: "b",
          }),
        ),
      /Children inherit their manager's PWA directory/,
    );
    assert.equal(
      store.read().agents.some((entry) => entry.name === "conflicting-child"),
      false,
    );
    nativeWorkspaces.set(plannerA.paseoAgentId, "actual-parent-workspace");
    nativeWorkspaces.set("same-workspace-native", "actual-parent-workspace");
    nativeParents.set("same-workspace-native", plannerA.paseoAgentId);
    assert.equal(plannerA.workspaceId, null);
    await assert.rejects(
      async () =>
        invoke(
          registerAgentRpc.name,
          registerAgentRpc.input.parse({
            paseoAgentId: "same-workspace-native",
            name: "same-workspace",
            roleClass: "supervisor",
            role: "supervisor",
            reportsTo: plannerA.qualifiedName,
            workspaceId: "actual-parent-workspace",
          }),
        ),
      /Prepare a separate workspace/,
    );
    assert.equal(
      store.read().agents.some((entry) => entry.paseoAgentId === "same-workspace-native"),
      false,
    );
    // Project navigation and unscoped identity reads do not load the PWA config.
    writeFileSync(getConfigPath(), "corrupt config");
    assert.deepEqual((await board({})).tasks, store.read().tasks);
    assert.deepEqual((await board({ projectId: "project" })).tasks, []);
    await assert.rejects(async () => board({ projectId: "missing" }), /Unknown project/);
    const unavailableRootTask = createTaskRpc.output.parse(
      await invoke(
        createTaskRpc.name,
        createTaskRpc.input.parse({
          id: "unavailable-root",
          title: "Unavailable root",
          brief: "Manager stays available",
          status: "historic-raw-status",
          managerName: managerA.qualifiedName,
          createdBy: plannerA.qualifiedName,
        }),
      ),
    );
    const unavailableRootActivity = appendActivityRpc.output.parse(
      await invoke(
        appendActivityRpc.name,
        appendActivityRpc.input.parse({
          taskId: unavailableRootTask.id,
          actorName: managerA.qualifiedName,
          kind: "report",
          body: "Preserve this existing Activity",
        }),
      ),
    );
    unavailable.clear();
    unavailable.add(plannerA.paseoAgentId);
    const withoutRoot = await board({ projectId: "project" });
    assert.equal(
      withoutRoot.agents.some((entry) => entry.paseoAgentId === plannerA.paseoAgentId),
      false,
    );
    assert.equal(withoutRoot.unassignedTaskCount, 1);
    const directWhileRootUnavailable = await board({});
    assert.ok(
      directWhileRootUnavailable.agents.some(
        (entry) => entry.paseoAgentId === managerA.paseoAgentId,
      ),
    );
    assert.ok(
      directWhileRootUnavailable.tasks.some((entry) => entry.id === unavailableRootTask.id),
    );
    assert.ok(
      directWhileRootUnavailable.activities.some(
        (entry) => entry.id === unavailableRootActivity.id,
      ),
    );
    const unassigned = await board({ projectId: "project", unassigned: true });
    assert.deepEqual(unassigned.tasks, [unavailableRootTask]);
    assert.equal(unassigned.tasks[0].status, "historic-raw-status");
    assert.deepEqual(unassigned.activities, [unavailableRootActivity]);
    unavailable.delete(plannerA.paseoAgentId);
    const withRoot = await board({ projectId: "project" });
    assert.ok(withRoot.agents.some((entry) => entry.paseoAgentId === plannerA.paseoAgentId));
    assert.equal(withRoot.unassignedTaskCount, 0);
    const reassigned = await board({ projectId: "project", unassigned: true });
    assert.deepEqual(reassigned.tasks, []);
    assert.deepEqual(reassigned.activities, []);
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
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = resolve(__dirname, "../pwa/pr-workflow");
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
          pwaDirectory: ".",
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
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
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
