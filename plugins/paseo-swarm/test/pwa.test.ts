import { strict as assert } from "node:assert";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { initialPrompt } from "../server/prompts";
import { discoverPwas, listPwaRoles, readPwa, readPwaStatuses } from "../server/pwa";
import {
  readPwaSource,
  readPwaSourceConfig,
  requirePwaSource,
  resolvePwaBinding,
  validatePwaBinding,
  writePwaSource,
} from "../server/source";
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

test("flat roles directories discover files and retain containment", () => {
  const directory = fixture();
  const outside = fixture();
  try {
    assert.deepEqual(
      listPwaRoles(directory).map((role) => role.role),
      ["developer", "supervisor"],
    );
    assert.equal(readPwa(directory, "developer").roleBody, "Developer guidance.");
    symlinkSync(join(outside, "roles", "developer.md"), join(directory, "roles", "escape.md"));
    assert.throws(() => readPwa(directory, "escape"), /outside content root/);
    rmSync(join(directory, "roles", "escape.md"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
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

test("project sources preserve legacy config and unrelated settings", () => {
  const home = mkdtempSync(join(tmpdir(), "swarm-source-"));
  const directory = fixture();
  const other = fixture();
  agreement(other);
  const previousHome = process.env.PASEO_HOME;
  const previousRoot = process.env.PASEO_SWARM_PWA_ROOT;
  process.env.PASEO_HOME = home;
  process.env.PASEO_SWARM_PWA_ROOT = directory;
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
    assert.deepEqual(readPwaSourceConfig("one"), { path: other });
    assert.deepEqual(readPwaSourceConfig("two"), { path: directory });
    assert.equal(readPwaSource("unconfigured"), directory);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(config.retained, { value: 1 });
    assert.deepEqual(config.projectSources, { one: other, two: directory });
    assert.throws(
      () => writePwaSource({ path: other, projectId: "three" }),
      /Missing project root/,
    );
    assert.throws(() => writePwaSource({ path: "   " }), /Enter a PWA directory/);
    // A content parent remains configurable even when an individual PWA is broken.
    writeFileSync(join(other, "PWA.md"), "invalid");
    assert.equal(writePwaSource({ path: other }), other);
    assert.match(discoverPwas(other).entries[0].error ?? "", /YAML frontmatter/);
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

function agreement(directory: string, title = "Example") {
  mkdirSync(join(directory, "roles"), { recursive: true });
  writeFileSync(
    join(directory, "PWA.md"),
    `---\nversion: 1\nproject: ${title}\nstatuses: [reading, completed]\n---\nAgreement.\n`,
  );
  writeFileSync(
    join(directory, "roles", "director.md"),
    "---\nversion: 1\nroleClass: planner\ntitle: Planner\n---\nPlan.\n",
  );
  writeFileSync(
    join(directory, "roles", "reader.md"),
    "---\nversion: 1\nroleClass: worker\n---\nRead.\n",
  );
}

test("discovery includes the root and descendants, keeps invalid entries, and skips hidden and linked directories", () => {
  const root = mkdtempSync(join(tmpdir(), "pwa-discovery-"));
  try {
    agreement(root, "Same title");
    agreement(join(root, "nested", "review"), "Same title");
    agreement(join(root, ".hidden"));
    agreement(join(root, "node_modules", "ignored"));
    mkdirSync(join(root, "broken"));
    writeFileSync(join(root, "broken", "PWA.md"), "broken");
    symlinkSync(join(root, "nested"), join(root, "alias"), "dir");
    const result = discoverPwas(root, { maxMilliseconds: 5000 });
    assert.equal(result.complete, true);
    assert.equal(result.rootError, undefined);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(
      result.entries.map((entry) => entry.directory),
      [".", "broken", "nested/review"],
    );
    assert.equal(result.entries[0].title, "Same title");
    assert.equal(result.entries[2].title, "Same title");
    assert.deepEqual(result.entries[0].statuses, ["reading", "completed"]);
    assert.match(result.entries[1].error ?? "", /YAML frontmatter/);
    assert.deepEqual(
      result.entries[0].roles.map((role) => role.role),
      ["director", "reader"],
    );
    assert.equal(
      resolvePwaBinding({ directory: "alias/review", contentRoot: root }).directory,
      join(root, "nested", "review"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery distinguishes empty roots, root failure, and incomplete limits", () => {
  const root = mkdtempSync(join(tmpdir(), "pwa-limits-"));
  try {
    assert.deepEqual(discoverPwas(root), { entries: [], complete: true, errors: [] });
    const missing = discoverPwas(join(root, "missing"));
    assert.equal(missing.complete, false);
    assert.match(missing.rootError ?? "", /ENOENT/);
    writeFileSync(join(root, "not-a-directory"), "file");
    assert.match(
      discoverPwas(join(root, "not-a-directory")).rootError ?? "",
      /Not a PWA content directory/,
    );
    agreement(root);
    agreement(join(root, "deep", "child"));
    const depth = discoverPwas(root, { maxDepth: 0, maxMilliseconds: 5000 });
    assert.equal(depth.complete, false);
    assert.equal(depth.rootError, undefined);
    assert.deepEqual(
      depth.entries.map((entry) => entry.directory),
      ["."],
    );
    assert.equal(
      depth.errors.some((error) => /depth limit/.test(error.error)),
      true,
    );
    const count = discoverPwas(root, { maxDirectories: 0 });
    assert.equal(count.complete, false);
    assert.deepEqual(count.entries, []);
    assert.match(count.errors[0].error, /limit/);
    const pwas = discoverPwas(root, { maxPwas: 0, maxMilliseconds: 5000 });
    assert.equal(pwas.complete, false);
    assert.deepEqual(pwas.entries, []);
    assert.match(pwas.errors[0].error, /PWA limit/);
    const entries = discoverPwas(root, { maxEntries: 0 });
    assert.equal(entries.complete, false);
    assert.match(entries.errors[0].error, /limit/);
    const roleBudget = discoverPwas(root, { maxEntries: 3, maxMilliseconds: 5000 });
    assert.equal(roleBudget.complete, false);
    assert.equal(
      roleBudget.errors.some((entry) => /limit/.test(entry.error)),
      true,
    );
    const elapsed = discoverPwas(root, { maxMilliseconds: 0 });
    assert.equal(elapsed.complete, false);
    assert.match(elapsed.errors[0].error, /limit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("flat role files and directory symlinks reuse only content-root-contained files", () => {
  const root = mkdtempSync(join(tmpdir(), "pwa-links-"));
  const outside = mkdtempSync(join(tmpdir(), "pwa-outside-"));
  const directory = join(root, "review");
  try {
    agreement(directory);
    mkdirSync(join(root, "shared"));
    const shared = join(root, "shared", "reader.md");
    writeFileSync(shared, "---\nversion: 1\nroleClass: worker\n---\nShared guidance.\n");
    rmSync(join(directory, "roles", "reader.md"));
    symlinkSync("../../shared/reader.md", join(directory, "roles", "reader.md"));
    assert.equal(readPwa(directory, "reader", root).roleBody, "Shared guidance.");
    assert.deepEqual(
      listPwaRoles(directory, root).map((role) => role.role),
      ["director", "reader"],
    );
    const revision = readPwa(directory, "reader", root).revision;
    writeFileSync(join(directory, "roles", "director.md"), "invalid unrelated role");
    assert.equal(readPwa(directory, "reader", root).revision, revision);
    writeFileSync(shared, readFileSync(shared, "utf8") + "\nchanged");
    assert.notEqual(readPwa(directory, "reader", root).revision, revision);
    const escaped = join(outside, "reader.md");
    writeFileSync(escaped, readFileSync(shared, "utf8"));
    rmSync(join(directory, "roles", "reader.md"));
    symlinkSync(escaped, join(directory, "roles", "reader.md"));
    assert.throws(() => readPwa(directory, "reader", root), /outside content root/);
    rmSync(join(directory, "roles"), { recursive: true });
    symlinkSync("../shared", join(directory, "roles"), "dir");
    assert.equal(readPwa(directory, "reader", root).roleBody, "Shared guidance.\n\nchanged");
    rmSync(join(directory, "roles"));
    symlinkSync(outside, join(directory, "roles"), "dir");
    assert.throws(() => listPwaRoles(directory, root), /outside content root/);
    symlinkSync(outside, join(root, "escape"), "dir");
    assert.throws(
      () => resolvePwaBinding({ directory: "escape", contentRoot: root }),
      /outside content root/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("current statuses remain readable with broken roles and never rewrite a previous prompt", () => {
  const directory = mkdtempSync(join(tmpdir(), "pwa-statuses-"));
  try {
    agreement(directory);
    const previous = readPwa(directory, "reader");
    const prompt = initialPrompt({
      pwa: previous,
      agent: { name: "reader", roleClass: "worker", role: "reader", reportsTo: null },
      brief: "Read",
    });
    writeFileSync(join(directory, "roles", "reader.md"), "broken");
    const entry = readFileSync(join(directory, "PWA.md"), "utf8");
    writeFileSync(
      join(directory, "PWA.md"),
      entry.replace("[reading, completed]", "[new-state, done]"),
    );
    assert.deepEqual(readPwaStatuses(directory), ["new-state", "done"]);
    assert.deepEqual(previous.statuses, ["reading", "completed"]);
    assert.doesNotMatch(prompt, /new-state/);
    const broken = discoverPwas(directory, { maxMilliseconds: 5000 }).entries[0];
    assert.equal(broken.title, "Example");
    assert.deepEqual(broken.statuses, ["new-state", "done"]);
    assert.match(broken.error ?? "", /YAML frontmatter/);
    writeFileSync(join(directory, "PWA.md"), entry.replace("[reading, completed]", "[]"));
    assert.deepEqual(readPwaStatuses(directory), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("canonical bindings survive source configuration changes, but not moves", () => {
  const home = mkdtempSync(join(tmpdir(), "pwa-binding-"));
  const root = join(home, "content");
  const replacement = join(home, "replacement");
  const previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = home;
  try {
    agreement(join(root, "one"));
    agreement(join(root, "two"));
    agreement(join(replacement, "next"));
    writePwaSource({ path: "content", projectId: "project", projectRoot: home });
    symlinkSync(root, join(home, "root-alias"), "dir");
    assert.equal(
      writePwaSource({ path: join(home, "root-alias"), projectId: "project", projectRoot: home }),
      root,
    );
    const binding = resolvePwaBinding({ projectId: "project", directory: "two" });
    assert.deepEqual(binding, {
      projectId: "project",
      contentRoot: root,
      directory: join(root, "two"),
    });
    assert.throws(() => resolvePwaBinding({ projectId: "project", directory: "" }), /explicitly/);
    writePwaSource({
      path: replacement,
      projectId: "project",
      projectRoot: home,
    });
    assert.deepEqual(validatePwaBinding(binding), binding);
    writeFileSync(join(root, "two", "roles", "reader.md"), "broken after prepare");
    assert.deepEqual(validatePwaBinding(binding), binding);
    assert.throws(
      () => readPwa(binding.directory, "reader", binding.contentRoot),
      /YAML frontmatter/,
    );
    writeFileSync(
      join(root, "two", "roles", "reader.md"),
      "---\nversion: 1\nroleClass: worker\n---\nRestored.\n",
    );
    assert.throws(
      () => resolvePwaBinding({ contentRoot: root, directory: "../replacement/next" }),
      /outside content root/,
    );
    renameSync(join(root, "two"), join(root, "moved"));
    assert.throws(() => validatePwaBinding(binding), /ENOENT/);
    assert.equal(
      readPwa(resolvePwaBinding({ contentRoot: root, directory: "moved" }).directory, "director")
        .roleClass,
      "planner",
    );
    const configPath = getConfigPath();
    writeFileSync(configPath, JSON.stringify({ pwaRoot: relative(process.cwd(), root) }));
    assert.deepEqual(readPwaSourceConfig("project", home), { path: root });
    writeFileSync(configPath, JSON.stringify({ projectSources: { project: "content" } }));
    assert.throws(() => readPwaSourceConfig("project"), /Missing project root/);
    assert.deepEqual(readPwaSourceConfig("project", home), { path: root });
    assert.equal(
      resolvePwaBinding({ projectId: "project", projectRoot: home, directory: "one" }).directory,
      join(root, "one"),
    );
  } finally {
    if (previousHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
