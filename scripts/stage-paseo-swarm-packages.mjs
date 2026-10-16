#!/usr/bin/env node
// Stage already-built packages only. Packing is a separate npm pack --ignore-scripts step.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainModule } from "./is-main-module.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const basenames = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];
const packageNames = new Map(
  basenames.map((name) => [`@getpaseo/${name}`, `@paseo-swarm/${name}`]),
);
const dependencySections = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const usage =
  "Usage: node scripts/stage-paseo-swarm-packages.mjs --version <version> --output <new-directory> [--source-sha <checkout-sha>] [--workflow-sha <sha>]";

function validateVersion(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version ?? "",
    );
  if (
    !match ||
    version.length > 256 ||
    match.slice(1, 4).some((part) => !Number.isSafeInteger(Number(part))) ||
    match[4]?.split(".").some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === "0")
  ) {
    throw new Error(
      "--version must be an exact semver without build metadata (e.g. 0.11.0-swarm.1)",
    );
  }
}

export function stageManifest(input, version) {
  validateVersion(version);
  const name = packageNames.get(input.name);
  if (!name) throw new Error(`Not one of the seven source packages: ${input.name}`);
  const manifest = structuredClone(input);
  manifest.name = name;
  manifest.version = version;
  for (const section of dependencySections) {
    for (const dependency of Object.keys(manifest[section] ?? {})) {
      if (!dependency.startsWith("@getpaseo/")) continue;
      const target = packageNames.get(dependency);
      if (!target)
        throw new Error(`${input.name}: unmapped internal ${section} entry ${dependency}`);
      manifest[section][dependency] = `npm:${target}@${version}`;
    }
  }
  // Staged packages have no checkout scripts or implicit build/publish lifecycle.
  delete manifest.scripts;
  delete manifest.private;
  manifest.publishConfig = { access: "public", registry: "https://registry.npmjs.org" };
  manifest.repository = {
    type: "git",
    url: "git+https://github.com/seven-mile/paseo.git",
    directory: `packages/${input.name.split("/")[1]}`,
  };
  if (input.name === "@getpaseo/cli") manifest.bin = { "paseo-swarm": "bin/paseo" };
  return manifest;
}

function compiledEntrypoints(value) {
  if (typeof value === "string")
    return value.startsWith("./") && !value.includes("*") ? [value] : [];
  return Object.entries(value ?? {}).flatMap(([condition, target]) =>
    condition === "source" ? [] : compiledEntrypoints(target),
  );
}

function isWithin(parent, target) {
  const relative = path.relative(parent, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function requireFile(file) {
  if (!(await lstat(file)).isFile()) throw new Error(`Missing regular compiled file: ${file}`);
}

async function preparePackage(basename, version, rootManifest) {
  const directory = path.join(repoRoot, "packages", basename);
  const input = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  if (input.name !== `@getpaseo/${basename}`)
    throw new Error(`Unexpected workspace name: ${input.name}`);
  const manifest = stageManifest(input, version);
  manifest.license ??= rootManifest.license;
  manifest.author ??= rootManifest.author;
  const files = (input.files ?? []).filter((file) => !file.startsWith("!"));
  if (!files.includes(basename === "server" ? "dist/server" : "dist")) {
    throw new Error(`${input.name}: expected compiled dist in files`);
  }
  for (const file of files) {
    if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[*?[\]{}]/.test(file)) {
      throw new Error(`${input.name}: unsupported files entry ${file}`);
    }
    const entry = await lstat(path.join(directory, file));
    if (!entry.isDirectory() && !entry.isFile())
      throw new Error(`Unsupported source entry: ${file}`);
  }
  const entrypoints = compiledEntrypoints(input.exports);
  if (input.main) entrypoints.push(input.main);
  if (input.types) entrypoints.push(input.types);
  if (basename === "protocol") entrypoints.push("dist/messages.js", "dist/messages.d.ts");
  if (basename === "cli") entrypoints.push("bin/paseo", "dist/index.js");
  if (basename === "server") {
    entrypoints.push(
      "dist/scripts/supervisor-entrypoint.js",
      "dist/scripts/mcp-stdio-socket-bridge-cli.mjs",
      "dist/server/terminal/terminal-worker-process.js",
      "dist/server/terminal/terminal-ts-loader.mjs",
      "dist/server/server/speech/providers/local/sherpa/assets/silero_vad.onnx",
      "dist/server/builtin-plugins/paseo-swarm/index.server.ts",
      "dist/server/builtin-plugins/paseo-swarm/paseo-plugin.json",
    );
  }
  for (const entry of new Set(entrypoints)) await requireFile(path.join(directory, entry));
  return { basename, directory, input, manifest, files };
}

async function includePackageEntry(basename, directory, source) {
  const sourceRelative = path.relative(directory, source).split(path.sep).join("/");
  if (
    (basename === "server" && sourceRelative === "dist/server/web-ui") ||
    source.endsWith(".map") ||
    source.endsWith(".tsbuildinfo") ||
    sourceRelative.split("/").some((part) => part === "node_modules" || part === ".git")
  )
    return false;
  const entry = await lstat(source);
  if (!entry.isDirectory() && !entry.isFile())
    throw new Error(`Unsupported source entry: ${source}`);
  return true;
}

export async function stagePackages({ version, output, sourceSha, workflowSha }) {
  validateVersion(version);
  if (!output?.trim()) throw new Error("--output is required");
  const git = (...args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  const checkoutSha = git("rev-parse", "HEAD");
  if (sourceSha !== undefined && sourceSha !== checkoutSha) {
    throw new Error("--source-sha must equal the source checkout HEAD");
  }
  if (workflowSha != null && !/^[0-9a-f]{40}$/i.test(workflowSha)) {
    throw new Error("--workflow-sha must be a full Git SHA");
  }
  const checkoutDirty = git("status", "--porcelain", "--untracked-files=normal").length > 0;
  const rootManifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const packages = [];
  // Validate every input before creating any output. This does not prove build freshness.
  for (const basename of basenames) {
    packages.push(await preparePackage(basename, version, rootManifest));
  }
  await requireFile(path.join(repoRoot, "LICENSE"));

  const requestedOutput = path.resolve(output);
  if (isWithin(path.join(repoRoot, "packages"), requestedOutput)) {
    throw new Error("--output must be outside the source packages directory");
  }
  await mkdir(path.dirname(requestedOutput), { recursive: true });
  const destination = path.join(
    await realpath(path.dirname(requestedOutput)),
    path.basename(requestedOutput),
  );
  const workspaceRoot = await realpath(path.join(repoRoot, "packages"));
  if (isWithin(workspaceRoot, destination)) {
    throw new Error("--output must be outside the source packages directory");
  }
  // mkdir without recursive refuses even an empty pre-existing directory or symlink.
  await mkdir(destination);
  try {
    const records = [];
    for (const { basename, directory, input, manifest, files } of packages) {
      const target = path.join(destination, basename);
      await mkdir(target);
      for (const file of files) {
        await mkdir(path.dirname(path.join(target, file)), { recursive: true });
        await cp(path.join(directory, file), path.join(target, file), {
          recursive: true,
          force: false,
          errorOnExist: true,
          filter: (source) => includePackageEntry(basename, directory, source),
        });
      }
      await cp(path.join(repoRoot, "LICENSE"), path.join(target, "LICENSE"), {
        force: false,
        errorOnExist: true,
      });
      if (basename === "cli") await chmod(path.join(target, "bin/paseo"), 0o755);
      const json = `${JSON.stringify(manifest, null, 2)}\n`;
      await writeFile(path.join(target, "package.json"), json, { flag: "wx" });
      records.push({
        directory: basename,
        sourceName: input.name,
        sourceVersion: input.version,
        name: manifest.name,
        version,
        manifestSha256: createHash("sha256").update(json).digest("hex"),
      });
    }
    await writeFile(
      path.join(destination, "staging-manifest.json"),
      `${JSON.stringify(
        {
          sourceSha: checkoutSha,
          checkoutDirty,
          workflowSha: workflowSha ?? null,
          compiledSourceVerified: false,
          headless: true,
          webUiBundled: false,
          cliBin: "paseo-swarm",
          packages: records,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
  return destination;
}

if (isMainModule(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        version: { type: "string" },
        output: { type: "string" },
        "source-sha": { type: "string" },
        "workflow-sha": { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) console.log(usage);
    else
      console.log(
        await stagePackages({
          version: values.version,
          output: values.output,
          sourceSha: values["source-sha"],
          workflowSha:
            values["workflow-sha"] ?? process.env.GITHUB_WORKFLOW_SHA ?? process.env.GITHUB_SHA,
        }),
      );
  } catch (error) {
    console.error(error.message);
    console.error(usage);
    process.exitCode = 1;
  }
}
