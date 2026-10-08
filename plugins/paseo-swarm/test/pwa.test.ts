import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  initialPrompt,
  messagePrompt,
  messageReceipt,
  runtimeNotification,
} from "../server/prompts";
import { listPwaRoles, readPwa } from "../server/pwa";
import { readPwaSource, requirePwaSource, writePwaSource } from "../server/source";
import { getConfigPath } from "../server/state";

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "pwa-"));
  mkdirSync(join(directory, "roles"));
  writeFileSync(
    join(directory, "PWA.md"),
    "---\nversion: 1\nproject: Example\nstatuses: [survey, completed]\n---\n\nGlobal guidance.\n",
  );
  writeFileSync(
    join(directory, "roles", "developer.md"),
    "---\nversion: 1\nroleClass: worker\ntitle: Developer\n---\n\nDeveloper guidance.\n",
  );
  writeFileSync(
    join(directory, "roles", "supervisor.md"),
    "---\nversion: 1\nroleClass: supervisor\ntitle: Supervisor\n---\n\nSupervisor guidance.\n",
  );
  return directory;
}

test("listPwaRoles returns validated role metadata", () => {
  const directory = fixture();
  try {
    assert.deepEqual(
      listPwaRoles(directory).map(({ role, roleClass, title }) => ({ role, roleClass, title })),
      [
        { role: "developer", roleClass: "worker", title: "Developer" },
        { role: "supervisor", roleClass: "supervisor", title: "Supervisor" },
      ],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readPwa reads global and selected role content and hashes both files", () => {
  const directory = fixture();
  try {
    const pwa = readPwa(directory, "developer");
    assert.deepEqual(
      {
        project: pwa.project,
        role: pwa.role,
        roleClass: pwa.roleClass,
        projectBody: pwa.projectBody,
        roleBody: pwa.roleBody,
        statuses: pwa.statuses,
      },
      {
        project: "Example",
        role: "developer",
        roleClass: "worker",
        projectBody: "Global guidance.",
        roleBody: "Developer guidance.",
        statuses: ["survey", "completed"],
      },
    );
    assert.match(pwa.revision, /^[a-f0-9]{64}$/);
    const firstRevision = pwa.revision;
    writeFileSync(
      join(directory, "roles", "developer.md"),
      readFileSync(join(directory, "roles", "developer.md"), "utf8") + "\nchanged",
    );
    assert.notEqual(readPwa(directory, "developer").revision, firstRevision);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readPwa rejects unsafe roles, missing roles, and invalid frontmatter", () => {
  const directory = fixture();
  try {
    assert.throws(() => readPwa(directory, "../developer"), /Invalid role slug/);
    assert.throws(() => readPwa(directory, "missing"), /Missing role/);
    writeFileSync(join(directory, "roles", "broken.md"), "# no frontmatter");
    assert.throws(() => readPwa(directory, "broken"), /must have YAML frontmatter/);
    writeFileSync(
      join(directory, "roles", "bad.md"),
      "---\nversion: 1\nroleClass: manager\n---\nbody",
    );
    assert.throws(() => readPwa(directory, "bad"), /roleClass is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("prompts keep role context scoped and orient agents without inventing work", () => {
  const pwa = {
    project: "Example",
    role: "developer",
    roleClass: "worker" as const,
    projectBody: "Global guidance.",
    roleBody: "Developer guidance.",
    statuses: ["survey", "completed"],
    revision: "rev",
  };
  const prompt = initialPrompt({
    pwa,
    agent: { name: "dev-one", roleClass: "worker", role: "developer", reportsTo: "lead" },
    brief: "Start with the assigned context.",
  });
  assert.match(prompt, /^<paseo-swarm-system-settings>\n/);
  assert.match(prompt, /framework-provided role-class operating settings/);
  assert.match(prompt, /Global guidance/);
  assert.match(prompt, /Developer guidance/);
  assert.match(prompt, /Do not create agents or Tasks/);
  assert.match(prompt, /Do not acknowledge receipts/);

  const supervisorPrompt = initialPrompt({
    pwa,
    agent: { name: "lead", roleClass: "supervisor", role: "developer", reportsTo: "planner" },
    brief: "Coordinate the work.",
  });
  assert.match(supervisorPrompt, /^<paseo-swarm-system-settings>\n/);
  assert.match(supervisorPrompt, /maintain Task Activities and progress/);
  assert.doesNotMatch(supervisorPrompt, /Execution/);
  assert.match(prompt, /or append Activities/);

  const plannerPrompt = initialPrompt({
    pwa,
    agent: { name: "planner", roleClass: "planner", role: "developer", reportsTo: null },
    brief: "Coordinate the project.",
  });
  assert.match(
    plannerPrompt,
    /Maintain the project direction, create or revise Tasks, delegate to supervisors/,
  );
  assert.match(
    plannerPrompt,
    /accountable to the human across the whole relevant workset[\s\S]*Read the board/,
  );
  assert.match(
    plannerPrompt,
    /statuses declared by the project PWA[\s\S]*stage faithful to current scoped work/,
  );
  assert.match(
    plannerPrompt,
    /idle Task with no active work[\s\S]*completed only when[\s\S]*no required human attention remains[\s\S]*latest Activity[\s\S]*blocker or dependency, next actor, and unblock trigger or next step/,
  );
  assert.match(plannerPrompt, /finished survey does not await hypothetical future execution/);
  assert.match(
    plannerPrompt,
    /Runtime idle, turn completion, and message delivery do not establish business completion/,
  );
  assert.match(
    plannerPrompt,
    /child or CI[\s\S]*without ending ownership[\s\S]*resume on substantive reports or decisions without repeated human prompting/,
  );
  for (const nonPlannerPrompt of [prompt, supervisorPrompt]) {
    assert.doesNotMatch(
      nonPlannerPrompt,
      /whole relevant workset|idle Task with no active work|hypothetical future execution/,
    );
  }
});

test("message and runtime prompts distinguish delivery from work", () => {
  assert.match(
    messagePrompt({
      id: "msg-1",
      sender: "dev-one",
      recipient: "lead",
      taskId: "survey-auth",
      message: "Finding",
    }),
    /agent-to-agent team message[\s\S]*Task: survey-auth\.[\s\S]*Team message msg-1 from dev-one:\nFinding/m,
  );
  assert.match(
    messageReceipt({ recipient: "lead", delivery: "accepted" }),
    /does not mean the recipient read it/,
  );
  assert.match(messageReceipt({ recipient: "lead", delivery: "accepted" }), /not a durable queue/);

  const idle = runtimeNotification({ agent: "dev-one", manager: "lead", status: "inactive" });
  assert.match(idle, /does not describe task completion/);
  assert.match(idle, /will do no further work unless it receives a next instruction/);
  assert.match(idle, /not a business activity/);
  assert.match(
    runtimeNotification({
      agent: "dev-one",
      manager: "lead",
      status: "completed",
      outcome: "turn completed",
      report: "Survey finished.",
    }),
    /<paseo-swarm-runtime-notification>[\s\S]*Framework roster notification[\s\S]*dev-one[\s\S]*Final agent response:\nSurvey finished\./,
  );
  assert.match(
    runtimeNotification({
      agent: "dev-one",
      manager: "lead",
      status: "canceled",
      outcome: "user stopped it",
    }),
    /does not establish Task completion/,
  );
  assert.doesNotMatch(
    runtimeNotification({
      agent: "dev-one",
      manager: "lead",
      status: "failed",
      outcome: "provider error",
    }),
    /finished/,
  );
});

test("project sources preserve config, use host fallback, and validate fresh files", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-source-"));
  const directory = fixture();
  const other = fixture();
  const previousHome = process.env.PASEO_HOME;
  const previousRoot = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = directory;
  const planner = "---\nversion: 1\nroleClass: planner\n---\nPlan.\n";
  writeFileSync(join(directory, "roles", "director.md"), planner);
  writeFileSync(join(other, "roles", "organizer.md"), planner);
  try {
    assert.equal(readPwaSource("unconfigured"), directory);
    const configPath = getConfigPath();
    mkdirSync(join(home, "plugin-data", "paseo-swarm"), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ pwaRoot: directory, retained: { value: 1 } }));
    assert.equal(writePwaSource({ path: ".", projectId: "one", projectRoot: other }), other);
    assert.equal(
      writePwaSource({ path: ".", projectId: "two", projectRoot: directory }),
      directory,
    );
    assert.equal(requirePwaSource("one"), other);
    assert.equal(readPwaSource("unconfigured"), directory);
    assert.equal(writePwaSource({ path: other }), other);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.retained, { value: 1 });
    assert.deepEqual(config.projectSources, { one: other, two: directory });
    const saved = readFileSync(configPath, "utf8");
    assert.throws(
      () => writePwaSource({ path: other, projectId: "three" }),
      /Missing project root/,
    );
    assert.throws(() => writePwaSource({ path: "   " }), /Enter a PWA directory/);
    writeFileSync(join(other, "roles", "developer.md"), "broken");
    assert.throws(() => writePwaSource({ path: other }), /YAML frontmatter/);
    assert.equal(readFileSync(configPath, "utf8"), saved);
    writeFileSync(
      join(other, "roles", "developer.md"),
      "---\nversion: 1\nroleClass: worker\n---\nUpdated role.\n",
    );
    const oldPrompt = initialPrompt({
      pwa: readPwa(other, "developer"),
      agent: { name: "dev", roleClass: "worker", role: "developer", reportsTo: null },
      brief: "Work",
    });
    writeFileSync(
      join(other, "PWA.md"),
      "---\nversion: 1\nproject: Changed\n---\nUpdated project.\n",
    );
    const fresh = readPwa(requirePwaSource("one"), "developer");
    assert.equal(fresh.project, "Changed");
    assert.equal(fresh.roleBody, "Updated role.");
    assert.doesNotMatch(oldPrompt, /Updated project/);
    writeFileSync(join(other, "PWA.md"), "invalid");
    assert.throws(() => writePwaSource({ path: other }), /PWA.md must have YAML frontmatter/);
    assert.equal(readFileSync(configPath, "utf8"), saved);
    rmSync(join(other, "roles", "organizer.md"));
    assert.throws(() => writePwaSource({ path: other }), /must contain a planner role/);
    assert.equal(readFileSync(configPath, "utf8"), saved);
    rmSync(join(directory, "PWA.md"));
    assert.throws(() => writePwaSource({ path: directory }), /Missing PWA.md.*ENOENT/);
    assert.equal(readFileSync(configPath, "utf8"), saved);
    writeFileSync(join(directory, "PWA.md"), "---\nversion: 1\nproject: Restored\n---\nGuidance.");
    writeFileSync(configPath, "invalid json");
    assert.throws(() => readPwaSource("one"), SyntaxError);
    assert.throws(() => writePwaSource({ path: directory }), SyntaxError);
    assert.equal(readFileSync(configPath, "utf8"), "invalid json");
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    if (previousRoot === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
    else process.env.PASEO_SWARM_PWA_ROOT = previousRoot;
    rmSync(home, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});
