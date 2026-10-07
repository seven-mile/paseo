// One Windows-only baseline observation; the existing full server run tests the candidate next.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const startedAt = performance.now();
const executionDeadline = startedAt + 30_000;
const cleanupDeadline = startedAt + 45_000;
const baseline = "47352bcf02edc2bc89f549973ba0203866b2861f";
const production = {
  "packages/server/src/utils/run-git-command.ts":
    "18a5235abe540b751fcb46568a1e6e0e69879865410962d08896e3a51dc27b4b",
  "packages/server/src/utils/worktree.ts":
    "9124eed51d221f64f71165027f0ea7a9fadeeefb3c92eed6feadc93f807a2659",
};
const caseName =
  "runGitCommand shell behavior stops Git-owned Windows helper descendants before timeout rejection";
const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = path.join(process.env.RUNNER_TEMP ?? "", "windows-git-ownership");
const execFileAsync = promisify(execFile);
const receipt = {
  baseline,
  node: process.version,
  budgetMs: 45_000,
  cleanupReserveMs: 15_000,
  outcome: "not-run",
  cleanupErrors: [],
};
let copyRoot;
let fixtureRoot;
let child;
let logFd;
let interrupted = false;
let interruptWait;
let originalHashes;

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    interrupted = true;
    interruptWait?.(new Error(`Interrupted by ${signal}`));
  });

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}
function recordError(error) {
  receipt.cleanupErrors.push(String(error));
}
function records() {
  const file = path.join(evidence, "old.ndjson");
  if (!existsSync(file)) return [];
  const bytes = readFileSync(file);
  assert.ok(bytes.length <= 64 * 1024, "ownership records exceed fixed bound");
  const lines = bytes.toString("utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length <= 8, "ownership event count exceeds one case");
  return lines.map((line) => JSON.parse(line));
}
function sourceHashes(directory) {
  const files = {};
  for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
    assert.ok(!entry.isSymbolicLink(), "source copy must not resolve back into the checkout");
    if (entry.isFile()) {
      const filename = path.join(entry.parentPath, entry.name);
      files[path.relative(directory, filename).replaceAll("\\", "/")] = hash(
        readFileSync(filename),
      );
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}
async function stop(pid) {
  if (!running(pid)) return;
  const timeout = Math.min(5000, Math.floor(cleanupDeadline - performance.now() - 1000));
  assert.ok(timeout > 0, "no cleanup time remains");
  try {
    await execFileAsync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      timeout,
      windowsHide: true,
    });
  } catch (error) {
    if (error.code !== 128) throw error;
  }
}

function recoverOwners(owned) {
  let phases = [];
  let started = false;
  let published = false;
  try {
    phases = records();
  } catch (error) {
    recordError(error);
  }
  for (const row of phases) {
    if (row.event === "git-start") started = true;
    if (row.event === "ready") published = true;
    for (const key of ["gitPid", "ownerPid", "descendantPid"]) {
      if (Number.isInteger(row[key]) && row[key] > 0) owned.add(row[key]);
    }
  }
  let directories = [];
  try {
    if (fixtureRoot) directories = readdirSync(fixtureRoot);
  } catch (error) {
    recordError(error);
  }
  for (const name of directories) {
    try {
      assert.match(name, /^paseo-git-shell-[^\\/]+$/);
      const filename = path.join(fixtureRoot, name, "owned-helper-pids.json");
      if (!existsSync(filename)) continue;
      const row = JSON.parse(readFileSync(filename, "utf8"));
      for (const key of ["owner", "descendant"]) {
        assert.ok(Number.isInteger(row[key]) && row[key] > 0, "invalid synthetic owner PID");
        owned.add(row[key]);
      }
      published = true;
    } catch (error) {
      recordError(error);
    }
  }
  return { started, published };
}

try {
  assert.equal(process.platform, "win32", "this observation requires a real Windows runner");
  assert.ok(
    process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP),
    "RUNNER_TEMP must be absolute",
  );
  mkdirSync(evidence, { recursive: true });
  for (const filename of ["old.ndjson", "old.log", "old-results.json", "execution.json"])
    assert.ok(
      !existsSync(path.join(evidence, filename)),
      "do not overwrite an earlier observation",
    );
  copyRoot = mkdtempSync(path.join(process.env.RUNNER_TEMP, "paseo-git-baseline-"));
  receipt.disposableDirectory = path.basename(copyRoot);
  fixtureRoot = path.join(copyRoot, "fixtures");
  mkdirSync(fixtureRoot);
  const server = path.join(copyRoot, "packages", "server");
  mkdirSync(server, { recursive: true });
  cpSync(path.join(root, "packages/server/src"), path.join(server, "src"), { recursive: true });
  for (const filename of [
    "package.json",
    "vitest.config.ts",
    ...readdirSync(path.join(root, "packages/server")).filter((name) =>
      /^tsconfig.*\.json$/.test(name),
    ),
  ]) {
    cpSync(path.join(root, "packages/server", filename), path.join(server, filename));
  }
  for (const filename of ["tsconfig.json", "tsconfig.base.json"])
    cpSync(path.join(root, filename), path.join(copyRoot, filename));
  symlinkSync(path.join(root, "node_modules"), path.join(copyRoot, "node_modules"), "junction");
  const localDependencies = path.join(root, "packages/server/node_modules");
  if (existsSync(localDependencies))
    symlinkSync(localDependencies, path.join(server, "node_modules"), "junction");
  originalHashes = Object.fromEntries(
    Object.keys(production).map((filename) => [
      filename,
      hash(readFileSync(path.join(root, filename))),
    ]),
  );
  // Validate the whole copied source before writing either baseline blob.
  const copiedSource = sourceHashes(path.join(server, "src"));
  for (const [filename, expected] of Object.entries(production)) {
    const bytes = execFileSync("git", ["show", `${baseline}:${filename}`], {
      cwd: root,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(hash(bytes), expected, `unexpected exact baseline blob ${filename}`);
    const destination = path.join(copyRoot, filename);
    assert.ok(
      realpathSync(destination).startsWith(realpathSync(copyRoot) + path.sep),
      "baseline production escapes disposable copy",
    );
    writeFileSync(destination, bytes);
    assert.equal(hash(readFileSync(destination)), expected);
    copiedSource[path.relative(path.join(server, "src"), destination).replaceAll("\\", "/")] =
      expected;
  }
  const provenance = {
    baseline,
    git: execFileSync("git", ["--version"], { encoding: "utf8", timeout: 5000 }).trim(),
    node: process.version,
    baselineProduction: production,
    candidateProduction: originalHashes,
    installedAndConfig: Object.fromEntries(
      [
        "package-lock.json",
        "packages/server/vitest.config.ts",
        "packages/server/package.json",
        "packages/plugin/package.json",
        "packages/plugin/src/server/process.ts",
        "packages/plugin/dist/server/process.js",
        "packages/plugin/dist/server/index.js",
      ].map((filename) => [filename, hash(readFileSync(path.join(root, filename)))]),
    ),
    copiedSource,
    dependencies: {
      root: realpathSync(path.join(copyRoot, "node_modules")),
      server: existsSync(localDependencies) ? realpathSync(localDependencies) : null,
    },
  };
  const testFile = "src/utils/run-git-command.windows-shell.test.ts";
  assert.equal(
    hash(readFileSync(path.join(server, testFile))),
    hash(readFileSync(path.join(root, "packages/server", testFile))),
    "current ownership case differs in baseline copy",
  );
  writeFileSync(path.join(evidence, "provenance.json"), JSON.stringify(provenance, null, 2) + "\n");
  assert.ok(
    !interrupted && performance.now() < executionDeadline,
    "baseline preparation exhausted execution budget",
  );
  logFd = openSync(path.join(evidence, "old.log"), "w");
  child = spawn(
    process.execPath,
    [
      path.join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      testFile,
      "--config",
      path.join(server, "vitest.config.ts"),
      "--root",
      server,
      "--maxWorkers=1",
      "--no-file-parallelism",
      "--bail=1",
      "-t",
      `^${caseName}$`,
      "--reporter=json",
      `--outputFile=${path.join(evidence, "old-results.json")}`,
    ],
    {
      cwd: server,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        TMP: fixtureRoot,
        TEMP: fixtureRoot,
        TMPDIR: fixtureRoot,
        PASEO_HOME: path.join(copyRoot, "paseo-home"),
        PASEO_GIT_OWNERSHIP_LOG: path.join(evidence, "old.ndjson"),
      },
    },
  );
  receipt.vitestPid = child.pid;
  receipt.commandStartedMs = performance.now() - startedAt;
  receipt.status = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("baseline observation exceeded execution deadline")),
      Math.max(1, executionDeadline - performance.now()),
    );
    const finish = (callback) => {
      clearTimeout(timer);
      interruptWait = undefined;
      callback();
    };
    interruptWait = (error) => finish(() => reject(error));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => resolve({ code, signal })));
    if (interrupted) interruptWait(new Error("Interrupted after baseline launch"));
  });
  const result = JSON.parse(readFileSync(path.join(evidence, "old-results.json"), "utf8"));
  assert.equal(result.testResults.length, 1, "baseline must report only the selected source file");
  assert.equal(
    realpathSync(result.testResults[0].name),
    realpathSync(path.join(server, testFile)),
    "JSON test source escapes the disposable copy",
  );
  assert.equal(
    result.testResults[0].message,
    "",
    "file-level errors invalidate the ownership comparison",
  );
  const executed = result.testResults
    .flatMap((file) => file.assertionResults)
    .filter((test) => test.status === "passed" || test.status === "failed");
  assert.equal(executed.length, 1, "baseline must execute exactly one non-skipped case");
  assert.equal(executed[0].fullName, caseName);
  const phases = records();
  const phase = (event) => {
    const matching = phases.filter((row) => row.event === event);
    assert.equal(matching.length, 1, `missing or repeated ${event}`);
    return matching[0];
  };
  const ready = phase("ready");
  assert.ok(
    [ready.gitPid, ready.ownerPid, ready.descendantPid].every(
      (pid) => Number.isInteger(pid) && pid > 0,
    ),
  );
  assert.ok(
    ready.elapsedMs - phase("git-start").elapsedMs < 10_000,
    "readiness did not precede the original command deadline",
  );
  assert.deepEqual(
    {
      originalTimeout: phase("timeout-contract").originalTimeout,
      cleanupFailure: phase("timeout-contract").cleanupFailure,
    },
    { originalTimeout: true, cleanupFailure: false },
  );
  assert.equal(phase("cleanup").errors, 0, "fixture cleanup failed");
  const settlement = phase("settlement");
  const alive = [settlement.gitAlive, settlement.ownerAlive, settlement.descendantAlive];
  assert.ok(alive.every((value) => typeof value === "boolean"));
  const deletion = phases.find((row) => row.event === "cwd-delete");
  if (executed[0].status === "failed") {
    assert.notEqual(receipt.status.code, 0);
    assert.equal(
      executed[0].failureMessages.length,
      1,
      "additional test errors invalidate the ownership comparison",
    );
    const failure = executed[0].failureMessages[0];
    const survivorFailure =
      alive.includes(true) &&
      failure.includes("AssertionError: Git timeout ownership: owners alive at public settlement");
    const busyFailure =
      alive.every((value) => value === false) &&
      deletion?.removed === false &&
      deletion.code === "EBUSY" &&
      failure.includes("Error: Git timeout ownership: cwd EBUSY before cleanup");
    assert.ok(
      survivorFailure || busyFailure,
      "old failure is not the observed ownership assertion or matching cwd EBUSY",
    );
    receipt.outcome = "old-red-observed-owned-survivor-or-cwd-failure";
  } else {
    assert.equal(receipt.status.code, 0);
    assert.ok(alive.every((value) => value === false));
    assert.equal(deletion?.removed, true);
    receipt.outcome = "old-green-gap-not-reproduced";
  }
} catch (error) {
  receipt.outcome = "invalid-or-interrupted-baseline-observation";
  receipt.error = String(error);
  process.exitCode = 1;
} finally {
  // Recover numeric owners even if the outer deadline interrupted Vitest before its finally.
  const owned = new Set();
  if (child?.pid) owned.add(child.pid);
  const recovery = recoverOwners(owned);
  if (recovery.started && !recovery.published)
    recordError(
      "helper ownership publication incomplete; unobserved descendants cannot be certified gone",
    );
  const stops = await Promise.allSettled([...owned].map(stop));
  for (const stopped of stops) if (stopped.status === "rejected") recordError(stopped.reason);
  let remaining = [...owned];
  try {
    while (remaining.length && performance.now() < cleanupDeadline - 1000) {
      remaining = remaining.filter(running);
      if (remaining.length) await delay(50);
    }
  } catch (error) {
    recordError(error);
  }
  receipt.ownedPids = [...owned];
  receipt.remainingPids = remaining;
  if (remaining.length) recordError("owned process disappearance unconfirmed");
  try {
    if (logFd !== undefined) closeSync(logFd);
  } catch (error) {
    recordError(error);
  }
  try {
    if (originalHashes)
      for (const [filename, expected] of Object.entries(originalHashes))
        assert.equal(
          hash(readFileSync(path.join(root, filename))),
          expected,
          "PR production source changed",
        );
    receipt.prProductionUntouched = originalHashes !== undefined;
  } catch (error) {
    recordError(error);
  }
  try {
    if (copyRoot && !remaining.length && !receipt.cleanupErrors.length)
      rmSync(copyRoot, { recursive: true, force: true });
    receipt.copyRemoved = copyRoot ? !existsSync(copyRoot) : true;
  } catch (error) {
    recordError(error);
  }
  receipt.elapsedMs = performance.now() - startedAt;
  receipt.budgetMet = receipt.elapsedMs <= 45_000;
  if (receipt.cleanupErrors.length || interrupted || !receipt.budgetMet) process.exitCode = 1;
  if (process.env.RUNNER_TEMP) {
    try {
      mkdirSync(evidence, { recursive: true });
      writeFileSync(path.join(evidence, "execution.json"), JSON.stringify(receipt, null, 2) + "\n");
    } catch (error) {
      recordError(error);
      process.exitCode = 1;
    }
  }
  console.log(JSON.stringify(receipt));
}
