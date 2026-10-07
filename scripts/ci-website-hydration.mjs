// One supported-CI WebKit baseline observation; the original full website suite follows.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
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
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

const started = performance.now();
const executionDeadline = started + 120_000;
const cleanupDeadline = started + 135_000;
const root = fileURLToPath(new URL("../", import.meta.url));
const baseline = "47352bcf02edc2bc89f549973ba0203866b2861f";
const product = "packages/website/src/plugins/plugin-search.tsx";
const oldHash = "3b3976bc8f2f934b0a16ede8468f8bc33cfe3230a4f5aa8dc6c54f673293defe";
const title = "preserves search typed before hydration";
const evidence = path.join(process.env.RUNNER_TEMP ?? "", "website-hydration");
const receipt = {
  baseline,
  node: process.version,
  outcome: "inconclusive",
  cleanupErrors: [],
  boundsMs: [120_000, 135_000],
};
const owned = new Map();
let copyRoot, child, logFd, interrupt, runnerGroup;
let cancelled = false;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const original = Object.fromEntries(
  [product, "packages/website/e2e/plugins.spec.ts", "packages/website/playwright.config.ts"].map(
    (name) => [name, hash(readFileSync(path.join(root, name)))],
  ),
);

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    cancelled = true;
    interrupt?.(new Error("interrupted"));
  });

function procRow(pid) {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  const row = stat
    .slice(stat.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/);
  return { parent: Number(row[1]), group: Number(row[2]), ticks: row[19], state: row[0] };
}
function cleanupError(stage, error) {
  const label = stage + ":" + error.name;
  if (!receipt.cleanupErrors.includes(label)) receipt.cleanupErrors.push(label);
}
function snapshot() {
  const rows = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      rows.set(Number(name), procRow(name));
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return rows;
}
function collect() {
  const rows = snapshot();
  const live = new Set(
    [...owned].filter(([pid, row]) => rows.get(pid)?.ticks === row.ticks).map(([pid]) => pid),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of rows)
      if (live.has(row.parent) && !live.has(pid)) {
        live.add(pid);
        changed = true;
      }
  }
  const groups = new Set([...live].map((pid) => rows.get(pid).group));
  for (const [pid, row] of rows)
    if (live.has(pid) || groups.has(row.group))
      owned.set(pid, { ticks: row.ticks, group: row.group, parent: row.parent });
  return [...owned]
    .filter(([pid, row]) => rows.get(pid)?.ticks === row.ticks && rows.get(pid).state !== "Z")
    .map(([pid]) => Object.assign({}, { pid }, rows.get(pid)));
}
async function freePorts() {
  const results = {};
  for (const port of [8187, 8188]) {
    try {
      await new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => server.close(resolve));
      });
      results[port] = true;
    } catch {
      results[port] = false;
    }
  }
  return results;
}
function cleanupRows() {
  try {
    return collect();
  } catch (error) {
    cleanupError("process-scan", error);
  }
  const rows = [];
  for (const [pid, ownedRow] of owned) {
    try {
      const row = procRow(pid);
      if (row.ticks === ownedRow.ticks && row.state !== "Z") rows.push({ pid, ...row });
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") cleanupError("owner-identity", error);
    }
  }
  return rows;
}
function directChildRunning() {
  return child?.pid !== undefined && child.exitCode === null && child.signalCode === null;
}
function fallbackDirectChild(signal, error) {
  if (error.code === "ESRCH" || error.code === "ENOENT") return;
  cleanupError("direct-session", error);
  try {
    child.kill(signal);
  } catch (failure) {
    cleanupError("direct-child", failure);
  }
}
async function cleanup() {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    // Returned detached child/session ownership exists before global /proc collection.
    if (directChildRunning()) {
      try {
        const row = procRow(child.pid);
        assert.equal(row.group, child.pid);
        const recorded = owned.get(child.pid);
        if (recorded) assert.equal(row.ticks, recorded.ticks);
        assert.notEqual(row.group, runnerGroup);
        process.kill(-child.pid, signal);
      } catch (error) {
        fallbackDirectChild(signal, error);
      }
    }
    const rows = cleanupRows();
    for (const group of new Set(rows.map((row) => row.group))) {
      try {
        assert.ok(Number.isInteger(runnerGroup));
        assert.notEqual(group, runnerGroup, "refuse runner group");
        const confirmed = rows
          .filter((row) => row.group === group)
          .some((ownedRow) => {
            try {
              const row = procRow(ownedRow.pid);
              return row.ticks === ownedRow.ticks && row.group === group && row.state !== "Z";
            } catch (error) {
              if (error.code !== "ENOENT" && error.code !== "ESRCH")
                cleanupError("group-identity", error);
              return false;
            }
          });
        if (confirmed) process.kill(-group, signal);
      } catch (error) {
        if (error.code !== "ESRCH") cleanupError("group-signal", error);
      }
    }
    const stop = Math.min(
      cleanupDeadline - 1000,
      performance.now() + (signal === "SIGTERM" ? 1500 : 4000),
    );
    while (cleanupRows().length && performance.now() < stop) await delay(25);
  }
  receipt.owners = [...owned].map(([pid, row]) => Object.assign({}, { pid }, row));
  receipt.remainingPids = cleanupRows().map((row) => row.pid);
  receipt.portsFreeAfter = await freePorts();
  receipt.releaseConfirmed =
    receipt.cleanupErrors.length === 0 &&
    receipt.remainingPids.length === 0 &&
    !directChildRunning() &&
    Object.values(receipt.portsFreeAfter).every(Boolean);
  if (!receipt.releaseConfirmed) cleanupError("release-unconfirmed", new Error());
}
function linkDependencies(source, destination) {
  if (!existsSync(source)) return;
  mkdirSync(destination, { recursive: true });
  for (const name of readdirSync(source)) {
    if (name.startsWith(".") && name !== ".bin") continue;
    if (name.startsWith("@") || name === ".bin") {
      const directory = path.join(destination, name);
      mkdirSync(directory);
      for (const leaf of readdirSync(path.join(source, name)))
        symlinkSync(realpathSync(path.join(source, name, leaf)), path.join(directory, leaf));
    } else symlinkSync(realpathSync(path.join(source, name)), path.join(destination, name));
  }
}
function readEvidence(attachment) {
  assert.equal(attachment?.contentType, "application/json");
  let attachmentBytes;
  if (attachment.path) {
    assert.ok(realpathSync(attachment.path).startsWith(realpathSync(evidence) + path.sep));
    attachmentBytes = readFileSync(attachment.path);
  } else {
    assert.ok(typeof attachment.body === "string" && attachment.body.length <= 350 * 1024);
    attachmentBytes = Buffer.from(attachment.body, "base64");
  }
  assert.ok(attachmentBytes.length <= 256 * 1024);
  writeFileSync(path.join(evidence, "old-evidence.json"), attachmentBytes, { flag: "wx" });
  return attachmentBytes;
}
function assertInitialQueryFailure(result, observed) {
  assert.equal(receipt.status.code, 1);
  assert.equal(observed.initialQueryReached, false);
  assert.equal(result.errors.length, 1);
  const copiedSpec = path.join(copyRoot, "packages/website/e2e/plugins.spec.ts");
  const lines = readFileSync(copiedSpec, "utf8").split("\n");
  const marker = lines.findIndex(
    (line) => line.trim() === "// Initial pre-hydration query assertion.",
  );
  assert.ok(
    marker >= 0 &&
      lines.filter((line) => line.includes("Initial pre-hydration query assertion.")).length === 1,
  );
  assert.equal(
    lines[marker + 1].trim(),
    "await expect(page).toHaveURL(/\\/plugins\\/all\\?q=graphite$/);",
  );
  assert.equal(realpathSync(result.errorLocation.file), realpathSync(copiedSpec));
  assert.equal(result.errorLocation.line, marker + 2);
  const message = stripVTControlCharacters(result.error.message);
  assert.ok(
    message.includes("toHaveURL") && message.includes("\\?q=graphite") && message.includes("5000"),
  );
  assert.equal(
    /Received string:\s*"([^"]*)"/.exec(message)?.[1],
    "http://127.0.0.1:8187/plugins/all",
  );
}
function classify(report) {
  const specs = [];
  const visit = (suite) => {
    specs.push(...(suite.specs ?? []));
    for (const next of suite.suites ?? []) visit(next);
  };
  for (const suite of report.suites ?? []) visit(suite);
  assert.equal(report.errors?.length ?? 0, 0);
  assert.equal(specs.length, 1);
  assert.equal(specs[0].title, title);
  assert.equal(specs[0].tests.length, 1);
  const test = specs[0].tests[0];
  assert.equal(test.projectName, "webkit");
  assert.equal(test.results.length, 1);
  const result = test.results[0];
  assert.equal(result.retry, 0);
  assert.ok(["passed", "failed"].includes(result.status), "setup/absent/timed-out case is invalid");
  const attachment = result.attachments.find((row) => row.name === "plugin-search-evidence");
  const trace = result.attachments.find((row) => row.name === "trace");
  assert.ok(trace?.path && realpathSync(trace.path).startsWith(realpathSync(evidence) + path.sep));
  const attachmentBytes = readEvidence(attachment);
  const observed = JSON.parse(attachmentBytes);
  assert.equal(observed.overflow, false);
  assert.deepEqual(observed.pageErrors, []);
  const target = observed.requests.filter(
    (row) => row.type === "document" && row.path === "/plugins/all" && row.phase === "target",
  );
  assert.equal(target.length, 1);
  assert.equal(target[0].status, 200);
  assert.ok(
    observed.requests.some(
      (row) =>
        row.type === "document" && row.path === "/" && row.phase === "root" && row.status === 200,
    ),
  );
  const scripts = observed.requests.filter(
    (row) => row.path.startsWith("/assets/") && row.path.endsWith(".js") && row.phase === "target",
  );
  const held = scripts.filter((row) => row.heldAtMs !== undefined);
  assert.ok(held.length > 0 && observed.declaredScripts.length > 0);
  for (const declared of observed.declaredScripts)
    assert.ok(
      held.some((row) => row.path === declared && row.heldAtMs < observed.releasedAtMs),
      "SSR startup declaration not held before release",
    );
  for (const row of scripts) {
    assert.equal(row.targetReferrer, true, "unknown startup document association");
    assert.equal(row.frameIsBrowse, true);
    assert.ok(
      row.startedAtMs >= target[0].responseAtMs,
      "ambiguous pre-commit/root script request",
    );
    assert.equal(row.status, 200, "post-release startup response missing/failed");
    assert.notEqual(row.failed, true);
    assert.ok(row.responseAtMs >= observed.releasedAtMs);
  }
  receipt.bootstrapAssociation =
    "same Request identity + target-document Referrer + real SSR declared startup + main response";
  let browse = false;
  const events = [];
  for (const text of observed.markers) {
    const match =
      /^plugin-search:(document-start|native|commit|change|navigate) ([\d.]+) (\{.*\})$/.exec(text);
    if (!match) continue;
    const fields = JSON.parse(match[3]);
    if (match[1] === "document-start") {
      browse = fields.browsePath === true;
      continue;
    }
    if (browse) events.push({ type: match[1], atMs: Number(match[2]), ...fields });
  }
  const input = events.find(
    (row) => row.type === "native" && row.event === "input" && row.trusted && row.termIsGraphite,
  );
  const commit = events.find((row) => row.type === "commit");
  assert.ok(
    input && commit && input.atMs < commit.atMs,
    "native input before FIRST component commit missing",
  );
  receipt.firstInput = input;
  receipt.firstCommit = commit;
  if (result.status === "failed") {
    assertInitialQueryFailure(result, observed);
    assert.equal(commit.termLength, 0);
    assert.equal(commit.inputIsGraphite, true);
    assert.ok(!events.some((row) => row.type === "change" && row.termIsGraphite));
    receipt.outcome = "old-red-matching-precommit-boundary-trace-review-required";
  } else {
    assert.equal(receipt.status.code, 0);
    assert.equal(observed.initialQueryReached, true);
    receipt.outcome = "old-green-gap-not-reproduced"; // FIRST commit may legitimately already contain graphite.
  }
  receipt.artifacts = { evidence: hash(attachmentBytes), trace: hash(readFileSync(trace.path)) };
}

try {
  assert.equal(process.platform, "linux");
  assert.ok(process.env.RUNNER_TEMP && path.isAbsolute(process.env.RUNNER_TEMP));
  mkdirSync(evidence, { recursive: true });
  assert.ok(!existsSync(path.join(evidence, "execution.json")), "do not repeat an observation");
  runnerGroup = procRow(process.pid).group;
  receipt.portsFreeBefore = await freePorts();
  assert.ok(Object.values(receipt.portsFreeBefore).every(Boolean));
  copyRoot = mkdtempSync(path.join(process.env.RUNNER_TEMP, "paseo-website-old-"));
  const website = path.join(copyRoot, "packages/website");
  const files = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  })
    .toString()
    .split("\0")
    .filter(
      (name) =>
        name &&
        (name.startsWith("packages/website/") ||
          name.startsWith("public-docs/") ||
          [
            "CHANGELOG.md",
            "package.json",
            "package-lock.json",
            "tsconfig.json",
            "tsconfig.base.json",
            "packages/app/assets/images/editor-apps/finder.png",
          ].includes(name) ||
          /^(?:packages\/[^/]+|packages\/builtin-plugins\/[^/]+|plugins)\/package.json$/.test(
            name,
          )),
    );
  const sources = {};
  for (const name of files) {
    assert.ok(
      !cancelled && performance.now() < executionDeadline,
      "copy exhausted baseline budget",
    );
    assert.ok(
      !/(?:^|\/)(?:\.env(?:\.|$)|node_modules|dist|test-results|\.wrangler|\.tanstack)(?:\/|$)/.test(
        name,
      ),
    );
    const source = path.join(root, name),
      destination = path.join(copyRoot, name);
    assert.ok(
      !lstatSync(source).isSymbolicLink() &&
        realpathSync(source).startsWith(realpathSync(root) + path.sep),
    );
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    assert.ok(
      !lstatSync(destination).isSymbolicLink() &&
        realpathSync(destination).startsWith(realpathSync(copyRoot) + path.sep),
    );
    sources[name] = hash(readFileSync(destination));
  }
  const old = execFileSync("git", ["show", `${baseline}:${product}`], {
    cwd: root,
    timeout: 5000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(hash(old), oldHash);
  writeFileSync(path.join(copyRoot, product), old);
  sources[product] = oldHash;
  linkDependencies(path.join(root, "node_modules"), path.join(copyRoot, "node_modules"));
  linkDependencies(
    path.join(root, "packages/website/node_modules"),
    path.join(website, "node_modules"),
  );
  writeFileSync(
    path.join(website, "playwright.hydration-old.config.ts"),
    'import { defineConfig } from "playwright/test";\nimport original from "./playwright.config";\nexport default defineConfig({ ...original, reporter: [["json", { outputFile: ' +
      JSON.stringify(path.join(evidence, "old-results.json")) +
      " }]] });\n",
  );
  writeFileSync(
    path.join(evidence, "provenance.json"),
    JSON.stringify(
      {
        baseline,
        original,
        sources,
        head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5000 })
          .toString()
          .trim(),
        dependencies: {
          root: realpathSync(path.join(root, "node_modules")),
          protocol: hash(
            readFileSync(path.join(root, "packages/protocol/dist/plugin-registry.js")),
          ),
        },
        executionDifference:
          "old selected WebKit1worker fresh isolated build; candidate original full multi-project suite/order",
      },
      null,
      2,
    ) + "\n",
  );
  assert.ok(!cancelled && performance.now() < executionDeadline);
  const env = {
    ...process.env,
    CI: "1",
    PWTEST_CACHE_DIR: path.join(copyRoot, "pw-cache"),
    TMPDIR: path.join(copyRoot, "tmp"),
    TMP: path.join(copyRoot, "tmp"),
    TEMP: path.join(copyRoot, "tmp"),
  };
  for (const name of [
    "WEBSITE_TEST_URL",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
    "DEBUG",
    "DEBUG_FILE",
  ])
    delete env[name];
  mkdirSync(env.TMPDIR);
  logFd = openSync(path.join(evidence, "old.log"), "wx");
  const args = [
    "run",
    "test:e2e",
    "--",
    "e2e/plugins.spec.ts",
    "--config=playwright.hydration-old.config.ts",
    "--project=webkit",
    `--grep=/${title}$/`,
    "--workers=1",
    "--retries=0",
    `--output=${path.join(evidence, "old-test-results")}`,
  ];
  receipt.command = ["npm", ...args];
  receipt.disposableSource = path.basename(copyRoot);
  child = spawn("npm", args, {
    cwd: website,
    env,
    detached: true,
    shell: false,
    stdio: ["ignore", logFd, logFd],
  });
  receipt.childPid = child.pid;
  receipt.directChildSessionGroup = child.pid;
  receipt.status = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(() => reject(new Error("baseline deadline"))),
      Math.max(1, executionDeadline - performance.now()),
    );
    const poll = setInterval(() => {
      try {
        collect();
      } catch (error) {
        interrupt(error);
      }
    }, 25);
    const finish = (callback) => {
      clearTimeout(timer);
      clearInterval(poll);
      interrupt = undefined;
      callback();
    };
    interrupt = (error) => finish(() => reject(error));
    child.once("error", (error) => finish(() => reject(error)));
    child.once("exit", (code, signal) => finish(() => resolve({ code, signal })));
    child.once("spawn", () => {
      try {
        const row = procRow(child.pid);
        owned.set(child.pid, { ticks: row.ticks, group: row.group, parent: row.parent });
        collect();
      } catch (error) {
        interrupt(error);
      }
    });
    if (cancelled) interrupt(new Error("interrupted"));
  });
  classify(JSON.parse(readFileSync(path.join(evidence, "old-results.json"), "utf8")));
} catch (error) {
  receipt.errorName = error.name;
  receipt.outcome = "invalid-or-interrupted-old-observation";
  process.exitCode = 1;
} finally {
  try {
    await cleanup();
  } catch (error) {
    cleanupError("cleanup", error);
  }
  try {
    if (logFd !== undefined) closeSync(logFd);
  } catch (error) {
    cleanupError("log-close", error);
  }
  for (const [name, expected] of Object.entries(original)) {
    try {
      assert.equal(hash(readFileSync(path.join(root, name))), expected);
    } catch (error) {
      cleanupError("checkout-hash", error);
    }
  }
  if (copyRoot && receipt.releaseConfirmed && receipt.cleanupErrors.length === 0) {
    try {
      rmSync(copyRoot, { recursive: true, force: true });
      receipt.copyRemoved = true;
    } catch (error) {
      cleanupError("copy-remove", error);
    }
  } else if (copyRoot) receipt.retainedCopy = path.basename(copyRoot);
  receipt.elapsedMs = performance.now() - started;
  if (receipt.elapsedMs > 135_000) cleanupError("budget-exceeded", new Error());
  if (receipt.cleanupErrors.length || !receipt.releaseConfirmed || cancelled) process.exitCode = 2;
  try {
    if (existsSync(evidence))
      writeFileSync(
        path.join(evidence, "execution.json"),
        JSON.stringify(receipt, null, 2) + "\n",
        { flag: "wx" },
      );
  } catch {
    process.exitCode = 2;
  }
  console.info(
    JSON.stringify({
      outcome: receipt.outcome,
      elapsedMs: receipt.elapsedMs,
      cleanupErrors: receipt.cleanupErrors,
    }),
  );
}
