import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listPwaRoles, pwaFilesRevision, readPwa, readPwaFiles } from "../server/pwa";

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
      listPwaRoles(readPwaFiles(directory)).map(({ role, roleClass, title }) => ({
        role,
        roleClass,
        title,
      })),
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
    const pwa = readPwa(readPwaFiles(directory), "developer");
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
    assert.notEqual(readPwa(readPwaFiles(directory), "developer").revision, firstRevision);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readPwa rejects unsafe roles, missing roles, and invalid frontmatter", () => {
  const directory = fixture();
  try {
    const files = readPwaFiles(directory);
    assert.throws(() => readPwa(files, "../developer"), /Invalid role slug/);
    assert.throws(() => readPwa(files, "missing"), /Missing role/);
    writeFileSync(join(directory, "roles", "broken.md"), "# no frontmatter");
    assert.throws(() => readPwa(readPwaFiles(directory), "broken"), /must have YAML frontmatter/);
    writeFileSync(
      join(directory, "roles", "bad.md"),
      "---\nversion: 1\nroleClass: manager\n---\nbody",
    );
    assert.throws(() => readPwa(readPwaFiles(directory), "bad"), /roleClass is invalid/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("readPwaFiles reads PWA.md and role files only, and the revision covers every file", () => {
  const directory = fixture();
  try {
    writeFileSync(join(directory, "roles", "notes.txt"), "not a role");
    writeFileSync(join(directory, "README.md"), "not the PWA");
    const files = readPwaFiles(directory);
    assert.deepEqual(Object.keys(files).sort(), [
      "PWA.md",
      "roles/developer.md",
      "roles/supervisor.md",
    ]);
    const revision = pwaFilesRevision(files);
    assert.equal(pwaFilesRevision({ ...files }), revision);
    assert.notEqual(
      pwaFilesRevision({ ...files, "roles/supervisor.md": `${files["roles/supervisor.md"]}!` }),
      revision,
    );
    rmSync(join(directory, "PWA.md"));
    assert.throws(() => readPwaFiles(directory), /Missing PWA.md.*ENOENT/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
