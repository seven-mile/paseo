import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ApprovalService } from "../server/approvals";
import { classifyCommand, startGate, type GateEvent, type GateRequest } from "../server/gate";
import { attachPaseo, type PaseoApi } from "../server/runtime";
import { store } from "../server/state";
import type { AgentRecord, Task } from "../shared/models";

const timestamp = "2026-10-22T00:00:00Z";
const worker: AgentRecord = {
  id: "worker-record",
  paseoAgentId: "worker-agent",
  name: "worker",
  qualifiedName: "manager.worker",
  aliases: [],
  roleClass: "worker",
  role: "developer",
  reportsTo: "manager",
  workspaceId: "workspace",
  retired: false,
  createdAt: timestamp,
  updatedAt: timestamp,
};
const task: Task = {
  id: "ship-it",
  title: "Ship it",
  brief: "Ship it.",
  status: "development",
  managerName: "manager",
  workerNames: ["manager.worker"],
  createdBy: "manager",
  data: {},
  createdAt: timestamp,
  updatedAt: timestamp,
};

test("classifyCommand gates push, PR and MR effects only", () => {
  const cases: Array<[string, string[], string | null]> = [
    ["git", ["push", "origin", "main"], "push"],
    ["git", ["-C", "/repo", "-c", "user.name=x", "push"], "push"],
    ["git", ["--no-pager", "log", "push"], null],
    ["git", ["-C", "push", "status"], null],
    ["git", ["commit", "-m", "push"], null],
    ["gh", ["pr", "create", "--fill"], "pr_create"],
    ["gh", ["-R", "owner/repo", "pr", "merge", "12"], "pr_merge"],
    ["gh", ["pr", "ready"], "pr_ready"],
    ["gh", ["pr", "view", "12"], null],
    ["gh", ["issue", "create"], null],
    ["glab", ["mr", "create"], "mr_create"],
    ["glab", ["mr", "merge", "4"], "mr_merge"],
    ["glab", ["mr", "list"], null],
  ];
  for (const [tool, args, expected] of cases) {
    assert.equal(classifyCommand(tool, args), expected, `${tool} ${args.join(" ")}`);
  }
});

test(
  "shims run ungated commands directly and hold gated ones on the gate's decision",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), "swarm-gate-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const realBin = join(root, "real");
    mkdirSync(realBin);
    for (const tool of ["git", "gh"]) {
      writeFileSync(join(realBin, tool), `#!/bin/sh\necho "real ${tool} $*"\n`);
      chmodSync(join(realBin, tool), 0o755);
    }
    const requests: GateRequest[] = [];
    let next: GateEvent = { type: "decision", decision: "allow", message: "" };
    const gate = await startGate({
      directory: join(root, "gate"),
      handler: async (request, emit) => {
        requests.push(request);
        emit({ type: "held", approvalId: "approval-1", message: "held for a human" });
        emit(next);
      },
    });
    t.after(() => gate.close());
    const env = {
      ...gate.env({ PATH: `${realBin}:${process.env.PATH}` }),
      PASEO_AGENT_ID: "worker-agent",
    };
    // The gate serves from this process, so the shim must run without blocking it.
    const run = (tool: string, args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
        const child = spawn(join(gate.binDirectory, tool), args, { env, cwd: root });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("close", (status) => done({ status, stdout, stderr }));
      });

    const status = await run("git", ["status", "--short"]);
    assert.equal(status.status, 0);
    assert.equal(status.stdout, "real git status --short\n");
    assert.equal(requests.length, 0);

    const allowed = await run("git", ["-C", root, "push", "origin"]);
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, `real git -C ${root} push origin\n`);
    assert.match(allowed.stderr, /held for a human/);
    assert.deepEqual(requests.at(-1), {
      agentId: "worker-agent",
      tool: "git",
      args: ["-C", root, "push", "origin"],
      cwd: root,
    });

    next = { type: "decision", decision: "deny", message: "not yet" };
    const denied = await run("gh", ["pr", "merge", "3"]);
    assert.equal(denied.status, 1);
    assert.equal(denied.stdout, "");
    assert.match(denied.stderr, /not yet/);

    next = { type: "decision", decision: "pending", message: "still waiting" };
    const pending = await run("gh", ["pr", "create"]);
    assert.equal(pending.status, 75);
    assert.equal(pending.stdout, "");

    assert.equal(
      gate
        .env(env)
        .PATH.split(":")
        .filter((entry) => entry === gate.binDirectory).length,
      1,
    );
  },
);

function fakePaseo() {
  const raised: Array<{ agentId: string; title?: string }> = [];
  const responses: Array<{ agentId: string; requestId: string; behavior: string }> = [];
  const sends: Array<{ agentId: string; text: string }> = [];
  const paseo = {
    agents: {
      ref(agentId: string) {
        return {
          async raisePermission(permission: { title?: string }) {
            raised.push({ agentId, title: permission.title });
            return { permissionId: `permission-${raised.length}` };
          },
          async respondToPermission(options: {
            requestId: string;
            response: { behavior: string };
          }) {
            responses.push({
              agentId,
              requestId: options.requestId,
              behavior: options.response.behavior,
            });
          },
          async send(text: string) {
            sends.push({ agentId, text });
          },
        };
      },
    },
  } as unknown as PaseoApi;
  return { paseo, raised, responses, sends };
}

async function setupState(t: { after(fn: () => void): void }, pwa = "../pwa/pr-workflow") {
  const home = mkdtempSync(join(tmpdir(), "swarm-approvals-"));
  const previousHome = process.env.PASEO_HOME;
  const previousPwa = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = resolve(__dirname, pwa);
  t.after(() => {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousPwa;
    rmSync(home, { recursive: true, force: true });
  });
  await store.commit(() => [
    { op: "put", collection: "agents", record: worker },
    { op: "put", collection: "tasks", record: task },
  ]);
  return home;
}

function gateCall(service: ApprovalService, args: string[], cwd: string) {
  const events: GateEvent[] = [];
  const done = service.handle(
    { agentId: worker.paseoAgentId, tool: "git", args, cwd },
    (event) => events.push(event),
    new AbortController().signal,
  );
  return { events, done };
}

test("an answer during the hold runs the command; a later answer messages the agent to rerun", async (t) => {
  const home = await setupState(t);
  const fake = fakePaseo();
  attachPaseo(fake.paseo);
  const service = new ApprovalService(50);

  const first = gateCall(service, ["push", "origin", "feature"], home);
  await delay(10);
  const [held] = store.read().approvals;
  assert.equal(held.status, "pending");
  assert.equal(held.taskId, "ship-it");
  assert.equal(held.permissionId, "permission-1");
  assert.deepEqual(fake.raised, [
    { agentId: worker.paseoAgentId, title: "Push commits (manager.worker)" },
  ]);
  await service.resolvePermission("permission-1", { behavior: "allow" }, fake.paseo);
  await first.done;
  assert.deepEqual(first.events.at(-1), { type: "decision", decision: "allow", message: "" });
  assert.equal(store.read().approvals[0].status, "consumed");
  assert.equal(fake.sends.length, 0);

  const second = gateCall(service, ["push", "origin", "feature"], home);
  await second.done;
  assert.equal((second.events.at(-1) as { decision: string }).decision, "pending");
  const deferred = store.read().approvals.find((approval) => approval.status === "pending")!;
  // A rerun before the answer waits on the same approval instead of raising another.
  const rerun = gateCall(service, ["push", "origin", "feature"], home);
  await rerun.done;
  assert.equal(store.read().approvals.length, 2);
  assert.equal(fake.raised.length, 2);

  await service.resolve(deferred.id, { behavior: "allow" }, fake.paseo);
  assert.equal(store.read().approvals.find((a) => a.id === deferred.id)!.status, "approved");
  assert.deepEqual(fake.responses, [
    { agentId: worker.paseoAgentId, requestId: "permission-2", behavior: "allow" },
  ]);
  assert.equal(fake.sends.length, 1);
  assert.match(fake.sends[0].text, /Rerun exactly that command/);

  const third = gateCall(service, ["push", "origin", "feature"], home);
  await third.done;
  assert.deepEqual(third.events, [{ type: "decision", decision: "allow", message: "" }]);
  assert.equal(store.read().approvals.find((a) => a.id === deferred.id)!.status, "consumed");

  // A different command needs its own approval.
  const other = gateCall(service, ["push", "--force", "origin", "feature"], home);
  await other.done;
  assert.equal((other.events.at(-1) as { decision: string }).decision, "pending");
});

test("a denial during the hold returns the feedback; a later denial is messaged", async (t) => {
  const home = await setupState(t);
  const fake = fakePaseo();
  attachPaseo(fake.paseo);
  const service = new ApprovalService(50);

  const held = gateCall(service, ["push"], home);
  await delay(10);
  await service.resolve(
    store.read().approvals[0].id,
    { behavior: "deny", message: "rebase first" },
    fake.paseo,
  );
  await held.done;
  assert.deepEqual(held.events.at(-1), {
    type: "decision",
    decision: "deny",
    message: "A human denied git push: rebase first",
  });
  assert.equal(store.read().approvals[0].status, "denied");
  assert.equal(fake.sends.length, 0);

  const later = gateCall(service, ["push"], home);
  await later.done;
  const pending = store.read().approvals.find((approval) => approval.status === "pending")!;
  await service.resolvePermission(pending.permissionId!, { behavior: "deny" }, fake.paseo);
  assert.equal(fake.sends.length, 1);
  assert.match(fake.sends[0].text, /denied `git push`/);
});

test("a PWA approvals list narrows what is gated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "swarm-approvals-pwa-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "roles"));
  writeFileSync(
    join(root, "PWA.md"),
    "---\nversion: 1\nproject: Example\napprovals: [pr_merge]\n---\n",
  );
  writeFileSync(join(root, "roles", "developer.md"), "---\nversion: 1\nroleClass: worker\n---\n");
  const home = await setupState(t, root);
  attachPaseo(fakePaseo().paseo);
  const service = new ApprovalService(50);
  const push = gateCall(service, ["push"], home);
  await push.done;
  assert.deepEqual(push.events, [{ type: "decision", decision: "allow", message: "" }]);
  assert.equal(store.read().approvals.length, 0);
});
