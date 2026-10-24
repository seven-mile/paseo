import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listPwaRoles, readPwa } from "../server/pwa";
import { initialPrompt } from "../server/prompts";
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
    writeFileSync(
      join(other, "PWA.md"),
      "---\nversion: 1\nproject: Changed\n---\nUpdated project.\n",
    );
    const fresh = readPwa(requirePwaSource("one"), "developer");
    assert.equal(fresh.project, "Changed");
    assert.equal(fresh.roleBody, "Updated role.");
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

test("preferredSeatModes is optional, parsed, and shown only to managers", () => {
  const directory = fixture();
  try {
    assert.deepEqual(readPwa(directory, "developer").preferredSeatModes, {});
    const agent = (roleClass: "supervisor" | "worker") => ({
      name: "seat",
      roleClass,
      role: roleClass === "worker" ? "developer" : "supervisor",
      reportsTo: null,
    });
    const prompt = (roleClass: "supervisor" | "worker") =>
      initialPrompt({
        pwa: readPwa(directory, roleClass === "worker" ? "developer" : "supervisor"),
        agent: agent(roleClass),
        brief: "Go",
      });
    // Framework guidance reaches managers once, and no one sees preferences nobody configured.
    assert.equal(prompt("supervisor").split("Provisioning seats:").length, 2);
    assert.doesNotMatch(prompt("worker"), /Provisioning seats:/);
    assert.doesNotMatch(prompt("supervisor"), /preferred seat modes/i);

    writeFileSync(
      join(directory, "PWA.md"),
      "---\nversion: 1\nproject: Example\npreferredSeatModes: { codex: full-access, claude: auto }\n---\n\nGlobal guidance.\n",
    );
    assert.deepEqual(readPwa(directory, "developer").preferredSeatModes, {
      codex: "full-access",
      claude: "auto",
    });
    assert.match(
      prompt("supervisor"),
      /preferred seat modes[^\n]*codex: full-access, claude: auto/,
    );
    assert.doesNotMatch(prompt("worker"), /preferred seat modes/i);

    writeFileSync(
      join(directory, "PWA.md"),
      "---\nversion: 1\nproject: Example\npreferredSeatModes: [codex]\n---\n\nGlobal guidance.\n",
    );
    assert.throws(() => readPwa(directory, "developer"), /preferredSeatModes/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
