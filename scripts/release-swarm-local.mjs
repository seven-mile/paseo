#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const appName = "Paseo Swarm.app";
const bundleId = "local.sevenmile.paseo.swarm";
const releaseRoot = path.join(root, ".dev", "swarm-releases");
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("PASEO_") && key !== "ELECTRON_RUN_AS_NODE",
    ),
  );

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: cleanEnv(),
    encoding: "utf8",
    timeout: 60_000,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} failed: ${result.error?.message ?? result.stderr?.trim() ?? result.status}`,
    );
  }
  return result.stdout.trim();
}

function assertSwarmBundle(bundle) {
  const identity = capture("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleIdentifier",
    path.join(bundle, "Contents", "Info.plist"),
  ]);
  if (identity !== bundleId)
    throw new Error(`Refusing to replace or launch a different application: ${bundle}`);
}

async function build(logFile) {
  const logFd = fs.openSync(logFile, "a");
  try {
    const args = [
      "run",
      "build:desktop",
      "--",
      "--mac",
      "dmg",
      `--${process.arch}`,
      "--publish",
      "never",
      "--config.directories.output=release/local",
    ];
    console.log(`→ npm ${args.join(" ")} (log: ${logFile})`);
    const child = spawn("npm", args, {
      cwd: root,
      env: { ...cleanEnv(), CSC_IDENTITY_AUTO_DISCOVERY: "false" },
      stdio: ["ignore", logFd, logFd],
    });
    const [code, signal] = await once(child, "exit");
    if (code !== 0) throw new Error(`npm failed (${signal ?? code}); see ${logFile}`);
  } finally {
    fs.closeSync(logFd);
  }
}

export function localReleasePlan(args) {
  if (args.length)
    throw new Error("Unknown option; use --help. Install the generated DMG manually.");
  return {
    artifact: path.join(
      root,
      "packages",
      "desktop",
      "release",
      "local",
      process.arch === "arm64" ? "mac-arm64" : "mac",
      appName,
    ),
    records: releaseRoot,
  };
}

export async function releaseLocal(args = process.argv.slice(2)) {
  if (args.includes("--help")) {
    console.log(
      "npm run release:local\nBuild and verify a local ad-hoc signed App/DMG in packages/desktop/release/local. Install dependencies with npm ci first. Quit Paseo Swarm, open the DMG, and drag the App into Applications to replace the previous version. Source is never pulled automatically.",
    );
    return;
  }
  const plan = localReleasePlan(args);
  if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
    throw new Error("This release command requires a supported macOS host.");
  fs.mkdirSync(plan.records, { recursive: true });
  const lock = path.join(plan.records, "release.lock");
  if (fs.existsSync(lock)) {
    const owner = Number(fs.readFileSync(lock, "utf8"));
    if (!Number.isSafeInteger(owner) || owner <= 0)
      throw new Error(`Invalid release lock: ${lock}`);
    try {
      process.kill(owner, 0);
      throw new Error(`Release already running (PID ${owner}).`);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.unlinkSync(lock);
  }
  const lockFd = fs.openSync(lock, "wx");
  fs.writeFileSync(lockFd, String(process.pid));
  fs.closeSync(lockFd);
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(plan.records, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  try {
    await build(path.join(runDir, "build.log"));
    const artifact = plan.artifact;
    assertSwarmBundle(artifact);
    capture("codesign", ["--verify", "--deep", "--strict", artifact]);
    console.log(
      `✓ Built and verified: ${artifact}\n✓ Build log: ${runDir}\nQuit Paseo Swarm, open the DMG in ${path.dirname(path.dirname(artifact))}, and drag the App into Applications to replace the previous version. Existing runtime data stays in your user directory.`,
    );
  } finally {
    fs.unlinkSync(lock);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  releaseLocal().catch((error) => {
    console.error(`Release failed: ${error.message}`);
    process.exitCode = 1;
  });
}
