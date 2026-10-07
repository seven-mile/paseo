// Temporary CI diagnostics; remove after Metro warmup attribution.
const { appendFileSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const config = require("../packages/app/metro.config.cjs");
const WorkerFarm = require("@expo/metro/metro/DeltaBundler/WorkerFarm").default;
const Server = require("@expo/metro/metro/Server").default;
const { Logger } = require("@expo/metro/metro-core");
const output = process.env.CI_METRO_OBSERVER_LOG;
const inflight = new Map();
const requests = new Set();
const observedFarms = new WeakSet();
let sequence = 0;
let writtenBytes = 0;
let dropped = 0;
let consoleRecords = 0;
const generated = path.resolve(
  config.projectRoot,
  "../protocol/dist/generated/validation/ws-outbound.aot.js",
);

Logger.on("log", (entry) => {
  if (entry.action_name === "Transforming file" && entry.action_phase === "end") {
    record("worker-transform-completed", {
      filename: entry.file_name,
      durationMs: entry.duration_ms,
    });
  }
});

function hashFile(filename) {
  try {
    return createHash("sha256").update(readFileSync(filename)).digest("hex");
  } catch {
    return null;
  }
}

// Observations must not throw into Metro or reject a side Promise.
function record(event, fields, print = false) {
  try {
    const line = JSON.stringify({
      event,
      pid: process.pid,
      utc: new Date().toISOString(),
      monotonicMs: performance.now(),
      ...fields,
    });
    const bytes = Buffer.byteLength(line) + 1;
    if (output && writtenBytes + bytes <= 16 * 1024 * 1024) {
      appendFileSync(output, line + "\n");
      writtenBytes += bytes;
    } else {
      dropped++;
    }
    if (print && consoleRecords < (event === "inflight-summary" ? 110 : 100)) {
      consoleRecords++;
      console.log("[metro-observer]", line);
    }
  } catch {
    dropped++;
  }
}

function snapshot(reason) {
  const now = performance.now();
  const remaining = [...inflight.values()].map((item) => ({
    id: item.id,
    filename: item.filename,
    elapsedMs: now - item.started,
  }));
  remaining.sort((a, b) => b.elapsedMs - a.elapsedMs);
  record(
    "inflight-summary",
    {
      reason,
      requests: [...requests],
      count: remaining.length,
      longest: remaining.slice(0, 30),
      writtenBytes,
      dropped,
    },
    true,
  );
}

const transform = WorkerFarm.prototype.transform;
WorkerFarm.prototype.transform = function (...args) {
  const [filename, options] = args;
  if (!observedFarms.has(this)) {
    observedFarms.add(this);
    record(
      "worker-farm-config",
      {
        maxWorkers: this._config.maxWorkers,
        stickyWorkers: this._config.stickyWorkers,
        workerThreads: this._config.transformer.unstable_workerThreads,
        transformerPath: this._transformerConfig.transformerPath,
        babelTransformerPath: this._transformerConfig.transformerConfig.babelTransformerPath,
      },
      true,
    );
  }
  const id = ++sequence;
  const started = performance.now();
  const absoluteFilename = path.resolve(this._config.projectRoot, filename);
  const generatedValidator = absoluteFilename === generated;
  inflight.set(id, { id, filename, started });
  record(
    "transform-start",
    {
      id,
      filename,
      absoluteFilename,
      requests: [...requests],
      generatedValidator,
      options: {
        platform: options.platform,
        dev: options.dev,
        minify: options.minify,
        type: options.type,
        inlineRequires: options.inlineRequires,
        experimentalImportSupport: options.experimentalImportSupport,
        unstable_transformProfile: options.unstable_transformProfile,
        reactCompiler: options.customTransformOptions?.reactCompiler,
      },
    },
    generatedValidator,
  );
  function settled(status, value) {
    try {
      const elapsedMs = performance.now() - started;
      inflight.delete(id);
      record(
        "transform-end",
        {
          id,
          filename,
          status,
          elapsedMs,
          sourceSHA1: status === "success" ? value?.sha1 : undefined,
          errorName: status === "error" ? value?.name : undefined,
        },
        generatedValidator || elapsedMs >= 200,
      );
    } catch {
      dropped++;
    }
  }
  let result;
  try {
    result = Reflect.apply(transform, this, args);
  } catch (error) {
    settled("error", error);
    throw error;
  }
  // Installed transform is async. Return its ORIGINAL Promise, not this side chain.
  result.then(
    (value) => settled("success", value),
    (error) => settled("error", error),
  );
  return result;
};

const processRequest = Server.prototype._processRequest;
Server.prototype._processRequest = function (...args) {
  const [req, res] = args;
  // Read the actual request without changing req.url, response, or transform options.
  try {
    const url = new URL(req.url, "http://metro.invalid");
    if (url.pathname.endsWith(".bundle")) {
      const id = ++sequence;
      const started = performance.now();
      requests.add(id);
      record(
        "bundle-request-start",
        {
          id,
          pathname: url.pathname,
          options: Object.fromEntries(
            [
              "platform",
              "dev",
              "minify",
              "lazy",
              "hot",
              "transform.engine",
              "transform.bytecode",
            ].map((key) => [key, url.searchParams.get(key)]),
          ),
          warmupBudgetMs: 120000,
        },
        true,
      );
      res.once("close", () => {
        record(
          "bundle-request-close",
          {
            id,
            elapsedMs: performance.now() - started,
            writableFinished: res.writableFinished,
            statusCode: res.statusCode,
          },
          true,
        );
        snapshot(res.writableFinished ? "bundle-response-finished" : "bundle-client-disconnected");
        requests.delete(id);
      });
    }
  } catch {
    dropped++;
  }
  return Reflect.apply(processRequest, this, args);
};

record(
  "provenance",
  {
    configStage: "before-Expo-overrides",
    node: process.version,
    platform: process.platform,
    commit: process.env.GITHUB_SHA,
    maxWorkers: config.maxWorkers,
    transformerPath: config.transformerPath,
    babelTransformerPath: config.transformer.babelTransformerPath,
    useWatchman: config.resolver.useWatchman,
    hashes: {
      observer: hashFile(__filename),
      metroConfig: hashFile(path.join(config.projectRoot, "metro.config.cjs")),
      babelConfig: hashFile(path.join(config.projectRoot, "babel.config.js")),
      warmup: hashFile(path.join(config.projectRoot, "e2e/support/metro-warmup.mjs")),
      generatedValidator: hashFile(generated),
      workerFarm: hashFile(require.resolve("metro/private/DeltaBundler/WorkerFarm")),
      worker: hashFile(require.resolve("metro/private/DeltaBundler/Worker")),
      workerImplementation: hashFile(
        path.join(
          path.dirname(require.resolve("metro/private/DeltaBundler/Worker")),
          "Worker.flow.js",
        ),
      ),
      server: hashFile(require.resolve("metro/private/Server")),
      transformer: hashFile(config.transformerPath),
    },
  },
  true,
);
process.once("exit", () => snapshot("process-exit"));
module.exports = config;
