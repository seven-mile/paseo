import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import type { createPaseoDaemon as createDaemonExport, PaseoDaemonConfig } from "@getpaseo/server";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { Route } from "@playwright/test";
import { metroTest, expect } from "../fixtures";
import { connectDaemonClient } from "./daemon-client-loader";
import { buildSeededHost, TEST_PROVIDER_PREFERENCES } from "./daemon-registry";
import { createTempGitRepo } from "./workspace";
import { boardReadRpc } from "../../../../../plugins/paseo-swarm/shared/swarm";

const checkout = path.resolve(__dirname, "../../../../../");
const protectedPorts = new Set([6767, 6768, 6769, 6799, 8101, 8102, 8103]);
type RunningDaemon = Awaited<ReturnType<typeof createDaemonExport>>;

export interface SwarmFixture {
  client: DaemonClient;
  serverId: string;
  port: number;
  workspaceId: string;
  projectId: string;
  projectName: string;
  contentRoot: string;
  board(input?: { teamName?: string }): Promise<ReturnType<typeof boardReadRpc.output.parse>>;
  nativePrompt(id: string): string | undefined;
}

async function createPwas(contentRoot: string) {
  await mkdir(path.join(contentRoot, "shared"), { recursive: true });
  await writeFile(
    path.join(contentRoot, "shared", "supervisor.md"),
    "---\nversion: 1\nroleClass: supervisor\ntitle: Shared supervisor\n---\n\nShared supervisor guidance.\n",
  );
  for (const [directory, title, status] of [
    ["alpha", "Alpha", "survey"],
    ["beta", "Beta", "queued"],
  ] as const) {
    const roles = path.join(contentRoot, directory, "roles");
    await mkdir(roles, { recursive: true });
    await writeFile(
      path.join(contentRoot, directory, "PWA.md"),
      `---\nversion: 1\nproject: ${title}\nstatuses: [${status}, completed]\n---\n\n${title} working agreement.\n`,
    );
    await writeFile(
      path.join(roles, "planner.md"),
      `---\nversion: 1\nroleClass: planner\ntitle: ${title} planner\n---\n\n${title} planner guidance.\n`,
    );
    // Both targets stay inside the Project content root; no roles-map extension.
    await symlink("../../shared/supervisor.md", path.join(roles, "supervisor.md"));
  }
}

async function stopDaemon(daemon: RunningDaemon) {
  const errors: unknown[] = [];
  try {
    await daemon.stop();
  } catch (error) {
    errors.push(error);
  }
  try {
    await daemon.agentManager.flush();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, "Private daemon stop/flush failed");
}

async function createDaemon(root: string, metroOrigin: string) {
  // Computed URLs preserve native ESM loading through Playwright. Build:server
  // produces these entries in the ordinary E2E CI job before tests run.
  const entry = pathToFileURL(
    path.join(checkout, "packages/server/dist/server/server/exports.js"),
  ).href;
  const loaderEntry = pathToFileURL(
    path.join(checkout, "packages/server/dist/server/server/plugins/builtin/index.js"),
  ).href;
  const factoryEntry = pathToFileURL(
    path.join(checkout, "packages/server/src/server/test-utils/fake-agent-client.ts"),
  ).href;
  const { createPaseoDaemon } = (await import(
    entry
  )) as typeof import("../../../../server/dist/server/server/exports.js");
  const { BuiltinPluginLoader } = (await import(
    loaderEntry
  )) as typeof import("../../../../server/dist/server/server/plugins/builtin/index.js");
  const { createTestAgentClients } = (await import(factoryEntry)) as {
    createTestAgentClients(): NonNullable<PaseoDaemonConfig["agentClients"]>;
  };
  const paseoHome = path.join(root, "home");
  const staticDir = path.join(root, "static");
  await mkdir(staticDir, { recursive: true });
  await mkdir(paseoHome, { recursive: true });
  return createPaseoDaemon(
    {
      listen: "127.0.0.1:0",
      paseoHome,
      staticDir,
      hostnames: true,
      mcpEnabled: false,
      mcpDebug: false,
      relayEnabled: false,
      relayEndpoint: "relay.paseo.sh:443",
      appBaseUrl: "https://app.paseo.sh",
      voiceLlmProvider: null,
      agentClients: createTestAgentClients(),
      agentStoragePath: path.join(paseoHome, "agents"),
      corsAllowedOrigins: [metroOrigin],
      pluginsEnabled: true,
    },
    pino({ level: "warn" }),
    {
      builtinPlugins: new BuiltinPluginLoader(path.join(checkout, "plugins"), ["paseo-swarm"]),
    },
  );
}

function safeUrl(url: URL) {
  return `${url.origin}${url.pathname}`;
}

function isOwned(url: URL, origins: Set<string>) {
  return !url.username && !url.password && origins.has(url.origin.replace(/^ws/, "http"));
}

async function forwardHttp(route: Route, origins: Set<string>, errors: string[]) {
  const url = new URL(route.request().url());
  try {
    if (["data:", "blob:"].includes(url.protocol)) return await route.continue();
    if (!isOwned(url, origins)) throw new Error(`Unowned HTTP ${safeUrl(url)}`);
    const response = await route.fetch({ maxRedirects: 0 });
    const locations = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "location");
    if (
      locations.length > 1 ||
      (response.status() >= 300 && response.status() < 400 && locations.length)
    ) {
      throw new Error(`Redirect forbidden ${safeUrl(url)}`);
    }
    await route.fulfill({ response });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "HTTP forwarding failed");
    await route.abort().catch(() => undefined);
  }
}

async function cleanup(action: () => Promise<unknown>, errors: string[], label: string) {
  try {
    await action();
  } catch (error) {
    errors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const swarmTest = metroTest.extend<{ swarm: SwarmFixture }>({
  serviceWorkers: "block",
  swarm: async ({ page, context, baseURL }, runFixture, testInfo) => {
    if (!baseURL) throw new Error("E2E Metro baseURL is required");
    const metro = new URL(baseURL);
    if (
      !["localhost", "127.0.0.1"].includes(metro.hostname) ||
      protectedPorts.has(Number(metro.port))
    ) {
      throw new Error("Swarm E2E requires an owned loopback Metro");
    }
    const previous = {
      PASEO_HOME: process.env.PASEO_HOME,
      PASEO_SWARM_PWA_ROOT: process.env.PASEO_SWARM_PWA_ROOT,
      E2E_SERVER_ID: process.env.E2E_SERVER_ID,
    };
    let root: string | undefined;
    let repo: Awaited<ReturnType<typeof createTempGitRepo>> | undefined;
    let daemon: RunningDaemon | undefined;
    let client: DaemonClient | undefined;
    let failed = false;
    let closing = false;
    const errors: string[] = [];
    const cleanupErrors: string[] = [];
    const pending = new Set<Promise<void>>();
    try {
      root = await mkdtemp(path.join(tmpdir(), "paseo-swarm-e2e-"));
      repo = await createTempGitRepo("swarm-project-");
      const contentRoot = path.join(repo.path, "pwas");
      await createPwas(contentRoot);
      process.env.PASEO_HOME = path.join(root, "home");
      delete process.env.PASEO_SWARM_PWA_ROOT;
      daemon = await createDaemon(root, metro.origin);
      const activeDaemon = daemon;
      await daemon.start();
      const target = daemon.getListenTarget();
      if (!target || target.type !== "tcp" || protectedPorts.has(target.port)) {
        throw new Error("Private Swarm daemon must bind an owned TCP port");
      }
      const port = target.port;
      client = await connectDaemonClient<DaemonClient>({ port, clientIdPrefix: "swarm-e2e" });
      const connected = client;
      const catalog = await client.getPluginCatalog();
      expect(catalog.map((plugin) => plugin.id)).toContain("paseo-swarm");
      const created = await client.createWorkspace({
        source: { kind: "directory", path: repo.path },
        title: "Multi PWA Project",
      });
      if (!created.workspace) throw new Error(created.error ?? "Private Project creation failed");
      const workspace = created.workspace;
      const serverId = daemon.getServerId();
      process.env.E2E_SERVER_ID = serverId;
      const origins = new Set([
        metro.origin,
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
      ]);
      await context.route("**/*", async (route) => {
        const operation = forwardHttp(route, origins, errors);
        pending.add(operation);
        try {
          await operation;
        } finally {
          pending.delete(operation);
        }
      });
      await context.routeWebSocket(/.*/, async (socket) => {
        const url = new URL(socket.url());
        if (!isOwned(url, origins)) {
          errors.push(`Unowned WebSocket ${safeUrl(url)}`);
          await socket.close({ code: 1008, reason: "Unowned E2E endpoint" });
          return;
        }
        socket.connectToServer();
      });
      page.on("pageerror", (error) => {
        errors.push(error.message);
      });
      page.on("requestfailed", (request) => {
        if (!closing) errors.push(`Request failed ${safeUrl(new URL(request.url()))}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400)
          errors.push(`HTTP ${response.status()} ${safeUrl(new URL(response.url()))}`);
      });
      await page.addInitScript(
        ({ host, preferences }) => {
          localStorage.setItem("@paseo:e2e", "1");
          localStorage.setItem("@paseo:daemon-registry", JSON.stringify([host]));
          localStorage.setItem("@paseo:create-agent-preferences", JSON.stringify(preferences));
        },
        {
          host: buildSeededHost({
            serverId,
            endpoint: `127.0.0.1:${port}`,
            nowIso: new Date().toISOString(),
          }),
          preferences: { provider: "claude", providerPreferences: TEST_PROVIDER_PREFERENCES },
        },
      );
      await runFixture({
        client,
        serverId,
        port,
        workspaceId: workspace.id,
        projectId: workspace.projectId,
        projectName: workspace.projectDisplayName,
        contentRoot,
        board: async (input = {}) =>
          boardReadRpc.output.parse(
            await connected.invokePluginRpc("paseo-swarm", boardReadRpc.name, {
              projectId: workspace.projectId,
              ...input,
            }),
          ),
        nativePrompt: (id) => activeDaemon.agentManager.getAgent(id)?.config.systemPrompt,
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      if (failed || testInfo.status !== testInfo.expectedStatus) {
        await cleanup(
          async () => {
            await page.screenshot({ path: testInfo.outputPath("swarm-failure.png") });
            await writeFile(testInfo.outputPath("swarm-failure.html"), await page.content());
          },
          cleanupErrors,
          "Failure capture",
        );
      }
      closing = true;
      await cleanup(() => context.close(), cleanupErrors, "Browser close");
      await Promise.allSettled(pending);
      const closingClient = client;
      const closingDaemon = daemon;
      if (closingClient) await cleanup(() => closingClient.close(), cleanupErrors, "Client close");
      if (closingDaemon)
        await cleanup(() => stopDaemon(closingDaemon), cleanupErrors, "Daemon stop/flush");
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const ownedRepo = repo;
      const ownedRoot = root;
      if (cleanupErrors.length === 0 && ownedRepo)
        await cleanup(() => ownedRepo.cleanup(), cleanupErrors, "Project cleanup");
      if (cleanupErrors.length === 0 && ownedRoot)
        await cleanup(
          () => rm(ownedRoot, { recursive: true, force: true }),
          cleanupErrors,
          "Home cleanup",
        );
      await cleanup(
        () =>
          writeFile(
            testInfo.outputPath("swarm-cleanup.json"),
            JSON.stringify({ errors, cleanupErrors }, null, 2),
          ),
        cleanupErrors,
        "Evidence write",
      );
    }
    expect(errors, "Swarm browser/network errors").toEqual([]);
    expect(cleanupErrors, "Swarm fixture cleanup errors").toEqual([]);
  },
});
