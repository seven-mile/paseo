import { randomUUID, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pino from "pino";
import type {
  createPaseoDaemon as createPaseoDaemonExport,
  PaseoDaemonConfig,
} from "@getpaseo/server";
import type {
  APIResponse,
  Route,
  TestInfo,
  WebSocketRoute,
  WebSocket as BrowserWebSocket,
} from "@playwright/test";
import { metroTest, expect, type Page } from "../fixtures";
import { connectDaemonClient } from "./daemon-client-loader";
import { createNodeWebSocketFactory } from "./node-ws-factory";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { buildSeededHost, TEST_PROVIDER_PREFERENCES } from "./daemon-registry";
import { createTempGitRepo } from "./workspace";
import { buildHostWorkspaceRoute } from "../../../src/utils/host-routes";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { AgentRecord, SwarmState } from "../../../../../plugins/paseo-swarm/shared/models";
import {
  boardReadRpc,
  pwaSourceReadRpc,
  prepareAgentRpc,
  bindPreparedAgentRpc,
} from "../../../../../plugins/paseo-swarm/shared/swarm";

const checkout = path.resolve(__dirname, "../../../../../");
const protectedPorts = new Set([6767, 6769, 8101, 6799, 8102, 8103]);
const stamp = "2026-10-17T00:00:00.000Z";

export type RepairPair = "repair/repair" | "old-app/current-core" | "current-app/old-core";

export interface MixedRpcObservation {
  socketId: number;
  uri: string;
  requestId: string;
  method: string;
  input: Record<string, unknown>;
  utc: string;
  responseUtc?: string;
  board?: { keys: string[]; taskIds: string[]; activityIds: string[] };
  roles?: Array<{ role: string; title: string }>;
  source?: { keys: string[]; path: string | null };
  prepared?: {
    agentId: string;
    systemPrompt: string;
    sha256: string;
    bytes: number;
    parentAgentId?: string | null;
  };
  bound?: {
    agentId: string;
    workspaceId: string | null;
    projectId?: string;
    reportsTo: string | null;
  };
  error?: { code: unknown };
}

export interface MixedCreationObservation {
  socketId: number;
  uri: string;
  requestId: string;
  agentId: string;
  systemPrompt: string;
  sha256: string;
  bytes: number;
  parentLabelPresent: boolean;
  parentLabel: string | undefined;
  source: unknown;
  utc: string;
  response?: { agentId?: string; workspaceId: string | null; error: string | null };
}

interface MixedBundleUrl {
  url: string;
  devValues: string[];
  minifyValues: string[];
  queryKeys: string[];
}

export interface MixedMainBundleObservation {
  sequence: number;
  kind: "main-entry-bundle";
  observedUtc: string;
  request: MixedBundleUrl & { method: string; resourceType: string };
  response: MixedBundleUrl & {
    status: number;
    contentType: string | null;
    sha256: string | null;
    bytes: number | null;
    bodyPath: string;
  };
  forwarded: boolean;
}

export interface MixedRepairEvidence {
  pair: Exclude<RepairPair, "repair/repair">;
  appRoot: string;
  coreRoot: string;
  rpc: MixedRpcObservation[];
  creations: MixedCreationObservation[];
  catalogs: Array<{
    socketId: number;
    uri: string;
    requestId: string;
    plugins: Array<{ id: string; clientBundleSha256: string; clientBundleBytes: number }>;
  }>;
  mainBundles: MixedMainBundleObservation[];
}

interface RepairLedger {
  lifecycle: unknown[];
  requests: unknown[];
  errors: string[];
  cleanup: string[];
}

export type RepairFaultKind = "none" | "settings-preview" | "wizard-bind";

interface FaultRpcObservation extends MixedRpcObservation {
  dispatched: boolean;
  replyForwarded?: boolean;
  held?: string;
  replySha256?: string;
  replyBytes?: number;
  deliverySequence?: number;
  pageDelivery?: PreviewDeliverySnapshot;
}

type ColdFaultLabel = "cold-source" | "cold-board";

interface ColdFaultCohort {
  released: boolean;
  members: Map<string, FaultRpcObservation>;
  replies: Map<string, { frame: Buffer; forward: () => void }>;
}

interface PreviewDeliveryReceipt {
  requestId: string;
  uri: string;
  type: string;
  sha256: string;
  bytes: number;
  receivedUtc: string;
  receivedAt: number;
  messageListeners: number;
  firstFrameAt?: number;
  secondFrameAt?: number;
  settled?: boolean;
}

interface PreviewDeliverySnapshot {
  armed: string | null;
  receipt: PreviewDeliveryReceipt | null;
  errors: string[];
}

type PreviewObserverWindow = Window & {
  __paseoRepairPreviewDelivery?: PreviewDeliverySnapshot;
};

interface FaultCreationObservation extends MixedCreationObservation {
  idempotencyKey: string | undefined;
  intentSha256: string;
}

export interface RepairFaultEvidence {
  kind: Exclude<RepairFaultKind, "none">;
  rpc: FaultRpcObservation[];
  creations: FaultCreationObservation[];
  sockets: Array<{
    id: number;
    uri: string;
    pageClosed: boolean;
    serverClosed: boolean;
    received: number;
    serverId?: string;
  }>;
  disconnects: Array<{
    socketId: number;
    requestId: string;
    method: string;
    reason: string;
    beforeDispatch: true;
    closeRequested: boolean;
  }>;
  events: Array<{
    utc: string;
    action: string;
    label?: string;
    requestId?: string;
    socketId?: number;
  }>;
}

export interface RepairFaultControl {
  evidence: RepairFaultEvidence;
  holdPreviewOrder(): void;
  holdColdTarget(): void;
  release(label: "preview-A" | "preview-B" | "cold-source" | "cold-board"): void;
  releasePreviewAAndSettle(page: Page): Promise<void>;
  disconnectNextPreview(): void;
  disconnectNextBind(): Promise<void>;
  assertColdTargetHealthy(): void;
  reconnectObserved(): boolean;
}

export interface RepairDaemon {
  root: string;
  client: DaemonClient;
  serverId: string;
  port: number;
  projectId: string;
  workspaceId: string;
  projectName: string;
  repo: string;
  legacyRoot: string;
  collection: string;
  missingRoot: string;
  agents: AgentRecord[];
  initial: SwarmState;
  configPath: string;
  invoke: (method: string, input: unknown) => Promise<unknown>;
  nativePrompt: (agentId: string) => string | undefined;
  mixed?: MixedRepairEvidence;
  fault?: RepairFaultControl;
  recordMixedEvidence: (entry: unknown) => void;
}

async function pwa(directory: string, title: string, statuses: string[], explicit: boolean) {
  await mkdir(path.join(directory, "roles"), { recursive: true });
  const aliases = explicit
    ? "roles:\n  lead: roles/planner.md\n  supervisor: roles/supervisor.md\n  worker: roles/worker.md\n"
    : "";
  await writeFile(
    path.join(directory, "PWA.md"),
    `---\nversion: 1\nproject: ${title}\nstatuses: [${statuses.join(", ")}]\n${aliases}---\n\n${title} working agreement.\n`,
  );
  for (const roleClass of ["planner", "supervisor", "worker"] as const) {
    await writeFile(
      path.join(directory, "roles", `${roleClass}.md`),
      `---\nversion: 1\nroleClass: ${roleClass}\ntitle: ${title} ${roleClass}\n---\n\n${title} ${roleClass} guidance.\n`,
    );
  }
}

async function stopDaemon(daemon: Awaited<ReturnType<typeof createPaseoDaemonExport>>) {
  const failures: unknown[] = [];
  try {
    await daemon.stop();
  } catch (error) {
    failures.push(error);
  }
  try {
    await daemon.agentManager.flush();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "Private Swarm daemon stop/flush failed");
}

function startupCleanupError(original: unknown, cleanupFailures: unknown[]) {
  return new AggregateError(
    [original, ...cleanupFailures],
    "Private daemon startup and cleanup failed",
    {
      cause: original,
    },
  );
}

async function privateDaemon(
  root: string,
  metroOrigin: string,
  swarm: boolean,
  coreRoot = checkout,
) {
  const daemonUrl = pathToFileURL(
    path.join(coreRoot, "packages/server/dist/server/server/exports.js"),
  ).href;
  const { createPaseoDaemon } = (await import(
    daemonUrl
  )) as typeof import("../../../../server/dist/server/server/exports.js");
  const pluginLoaderUrl = pathToFileURL(
    path.join(coreRoot, "packages/server/dist/server/server/plugins/builtin/index.js"),
  ).href;
  const { BuiltinPluginLoader } = (await import(
    pluginLoaderUrl
  )) as typeof import("../../../../server/dist/server/server/plugins/builtin/index.js");
  const paseoHome = path.join(root, "home", ".paseo");
  const staticDir = path.join(root, "static");
  await mkdir(paseoHome, { recursive: true });
  await mkdir(staticDir, { recursive: true });
  const factoryUrl = pathToFileURL(
    path.join(coreRoot, "packages/server/src/server/test-utils/fake-agent-client.ts"),
  ).href;
  const { createTestAgentClients } = (await import(factoryUrl)) as {
    createTestAgentClients: () => NonNullable<PaseoDaemonConfig["agentClients"]>;
  };
  const config: PaseoDaemonConfig = {
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
    pluginsEnabled: swarm,
  };
  const daemon = await createPaseoDaemon(config, pino({ level: "silent" }), {
    builtinPlugins: new BuiltinPluginLoader(
      path.join(coreRoot, "plugins"),
      swarm ? ["paseo-swarm"] : [],
    ),
  });
  try {
    await daemon.start();
    const target = daemon.getListenTarget();
    if (!target || target.type !== "tcp") throw new Error("Private daemon did not bind TCP");
    if (protectedPorts.has(target.port))
      throw new Error(`Private daemon selected protected port ${target.port}`);
    return { daemon, port: target.port, paseoHome };
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    try {
      await stopDaemon(daemon);
    } catch (cleanupError) {
      cleanupFailures.push(cleanupError);
    }
    if (cleanupFailures.length) throw startupCleanupError(error, cleanupFailures);
    throw error;
  }
}

async function connect(port: number, coreRoot = checkout) {
  if (coreRoot === checkout)
    return connectDaemonClient<DaemonClient>({ port, clientIdPrefix: "swarm-repair" });
  const clientUrl = pathToFileURL(
    path.join(coreRoot, "packages/client/dist/daemon-client.js"),
  ).href;
  const { DaemonClient: SelectedClient } = (await import(
    clientUrl
  )) as typeof import("../../../../client/dist/daemon-client.js");
  const selectedAppPackage = JSON.parse(
    await readFile(path.join(coreRoot, "packages/app/package.json"), "utf8"),
  ) as { version: string };
  const client = new SelectedClient({
    url: `ws://127.0.0.1:${port}/ws`,
    clientId: `swarm-repair-${randomUUID()}`,
    clientType: "cli",
    appVersion: selectedAppPackage.version,
    webSocketFactory: createNodeWebSocketFactory(),
  });
  await client.connect();
  return client;
}

async function seedLegacy(
  client: DaemonClient,
  repo: string,
  foreign: string,
  collection: string,
  legacyOnly = false,
) {
  const main = await client.createWorkspace({
    source: { kind: "directory", path: repo },
    title: "Swarm repair Project",
  });
  if (!main.workspace) throw new Error(main.error ?? "Missing private main workspace");
  const projectId = main.workspace.projectId;
  const foreignProject = await client.addProject(foreign);
  if (!foreignProject.project)
    throw new Error(foreignProject.error ?? "Missing private foreign Project");
  const definitions: Array<{
    name: string;
    roleClass: AgentRecord["roleClass"];
    parent: string | null;
    foreign?: boolean;
  }> = [
    { name: "qa-planner", roleClass: "planner", parent: null },
    { name: "qa-planner.left", roleClass: "supervisor", parent: "qa-planner" },
    { name: "qa-planner.right", roleClass: "supervisor", parent: "qa-planner" },
    { name: "qa-planner.left.nested", roleClass: "supervisor", parent: "qa-planner.left" },
    { name: "qa-other", roleClass: "planner", parent: null },
    { name: "qa-planner-outsider", roleClass: "planner", parent: null, foreign: true },
  ];
  const agents: AgentRecord[] = [];
  for (const definition of definitions) {
    let workspaceId = main.workspace.id;
    let cwd = repo;
    const targetProject = definition.foreign ? foreignProject.project.projectId : projectId;
    if (agents.length > 0) {
      cwd = path.join(definition.foreign ? foreign : repo, definition.name);
      await mkdir(cwd, { recursive: true });
      const created = await client.createWorkspace({
        source: { kind: "directory", path: cwd, projectId: targetProject },
        title: definition.name,
      });
      if (!created.workspace)
        throw new Error(created.error ?? `Missing ${definition.name} workspace`);
      workspaceId = created.workspace.id;
    }
    const parent = agents.find((agent) => agent.qualifiedName === definition.parent);
    const native = await client.createAgent({
      provider: "claude",
      cwd,
      workspaceId,
      title: definition.name,
      ...(parent ? { labels: { "paseo.parent-agent-id": parent.paseoAgentId } } : {}),
    });
    agents.push({
      id: randomUUID(),
      paseoAgentId: native.id,
      name: definition.name.split(".").at(-1)!,
      qualifiedName: definition.name,
      aliases: [],
      roleClass: definition.roleClass,
      role: definition.roleClass,
      reportsTo: definition.parent,
      workspaceId,
      projectId: targetProject,
      ...(definition.name === "qa-other" && !legacyOnly
        ? {
            pwaBinding: {
              projectId,
              contentRoot: collection,
              directory: path.join(collection, "alternate"),
            },
          }
        : {}),
      retired: false,
      createdAt: stamp,
      updatedAt: stamp,
    });
  }
  const specs = [
    ["qa-survey", "QA survey Task", "survey", "qa-planner.left"],
    ["qa-completed", "QA completed Task", "completed", "qa-planner.right"],
    ["qa-nested", "QA nested Task", "survey", "qa-planner.left.nested"],
    ["qa-queued", "QA alternate Task", "queued", "qa-other"],
    ["qa-historical", "QA historical Task", "historic-review", "qa-planner"],
    ["qa-unavailable", "QA unavailable Task", "completed", "qa-missing"],
    ["qa-foreign", "QA foreign Task", "survey", "qa-planner-outsider"],
  ];
  const state: SwarmState = {
    version: 1,
    agents,
    tasks: specs.map(([id, title, status, managerName]) => ({
      id,
      title,
      status,
      managerName,
      brief: `Retained brief for ${id}.`,
      workerNames: [],
      createdBy: managerName,
      data: {},
      createdAt: stamp,
      updatedAt: stamp,
    })),
    activities: specs.map(([taskId, , , actorName]) => ({
      id: `activity-${taskId}`,
      taskId,
      actorName,
      actorKind: "agent",
      replyTo: null,
      responseProfile: null,
      kind: "report",
      body: `Retained Activity for ${taskId}.${taskId === "qa-survey" ? " [Alternate Task](paseo-swarm://task/qa-queued)" : ""}`,
      data: {},
      refs: [],
      createdAt: stamp,
    })),
  };
  return {
    projectId,
    workspaceId: main.workspace.id,
    projectName: main.workspace.projectDisplayName,
    agents,
    state,
  };
}

function safeUrl(raw: string) {
  const url = new URL(raw);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function mixedRoots(pair: RepairPair, testInfo: TestInfo, ledger: RepairLedger) {
  const oldRoot = path.join(
    checkout,
    ".local/ui-evolution/multiple-pwa-repair-20261017/backend/abi-preparation/full-app-8968b5bd",
  );
  const coreRoot = pair === "current-app/old-core" ? oldRoot : checkout;
  if (pair === "repair/repair") return { coreRoot, mixed: undefined };
  const appRoot = pair === "old-app/current-core" ? oldRoot : checkout;
  const declaredAppRoot = testInfo.project.metadata.swarmAppSourceRoot;
  expect(typeof declaredAppRoot, "Private runner must declare its actual Metro source root").toBe(
    "string",
  );
  expect(await realpath(declaredAppRoot as string)).toBe(await realpath(appRoot));
  const pins = [];
  for (const relative of [
    "packages/server/dist/server/server/exports.js",
    "packages/server/dist/server/server/bootstrap.js",
    "packages/server/dist/server/server/plugins/builtin/index.js",
    "packages/server/src/server/test-utils/fake-agent-client.ts",
    "packages/client/dist/daemon-client.js",
    "packages/protocol/dist/messages.js",
    "plugins/paseo-swarm/paseo-plugin.json",
    "plugins/paseo-swarm/index.server.ts",
    "plugins/paseo-swarm/index.client.tsx",
    "plugins/paseo-swarm/shared/swarm.ts",
  ]) {
    const filename = path.join(coreRoot, relative);
    const bytes = await readFile(filename);
    pins.push({
      path: await realpath(filename),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  }
  const appEntry = path.join(appRoot, "packages/app/src/swarm/new-workspace-screen.tsx");
  const bytes = await readFile(appEntry);
  pins.push({
    path: await realpath(appEntry),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
  });
  const mixed: MixedRepairEvidence = {
    pair,
    appRoot: await realpath(appRoot),
    coreRoot: await realpath(coreRoot),
    rpc: [],
    creations: [],
    catalogs: [],
    mainBundles: [],
  };
  ledger.lifecycle.push({
    phase: "mixed-sources",
    declarationOnlyUntilRunnerMetroProof: true,
    pins,
    evidence: mixed,
  });
  return { coreRoot, mixed };
}

function recordMixedRpcOutput(entry: MixedRpcObservation, output: unknown) {
  switch (entry.method) {
    case "swarm.board.read": {
      const board = boardReadRpc.output.parse(output);
      entry.board = {
        keys: Object.keys(output as object).sort(),
        taskIds: board.tasks.map((task) => task.id).sort(),
        activityIds: board.activities.map((activity) => activity.id).sort(),
      };
      break;
    }
    case "swarm.pwa_roles.read":
      entry.roles = (output as Array<{ role: string; title: string }>).map(({ role, title }) => ({
        role,
        title,
      }));
      break;
    case "swarm.pwa_source.read": {
      const source = pwaSourceReadRpc.output.parse(output);
      entry.source = { keys: Object.keys(output as object).sort(), path: source.path };
      break;
    }
    case "swarm.agent.prepare": {
      const prepared = prepareAgentRpc.output.parse(output);
      entry.prepared = {
        agentId: prepared.agentId,
        systemPrompt: prepared.systemPrompt,
        sha256: createHash("sha256").update(prepared.systemPrompt).digest("hex"),
        bytes: Buffer.byteLength(prepared.systemPrompt, "utf8"),
        ...(prepared.parentAgentId !== undefined ? { parentAgentId: prepared.parentAgentId } : {}),
      };
      break;
    }
    case "swarm.agent.bind_workspace": {
      const bound = bindPreparedAgentRpc.output.parse(output);
      entry.bound = {
        agentId: bound.paseoAgentId,
        workspaceId: bound.workspaceId,
        projectId: bound.projectId,
        reportsTo: bound.reportsTo,
      };
      break;
    }
  }
}

function observeMixedSocket(
  socket: BrowserWebSocket,
  socketId: number,
  evidence: MixedRepairEvidence,
  seeded: Awaited<ReturnType<typeof seedLegacy>>,
  ledger: RepairLedger,
) {
  const uri = safeUrl(socket.url());
  const requests = new Map<string, MixedRpcObservation>();
  const creations = new Map<string, MixedCreationObservation>();
  const projects = new Set(seeded.agents.map((agent) => agent.projectId));
  const names = new Set(seeded.agents.map((agent) => agent.qualifiedName));
  const methods = new Set([
    "swarm.board.read",
    "swarm.pwa_roles.read",
    "swarm.pwa_source.read",
    "swarm.agent.prepare",
    "swarm.agent.bind_workspace",
    "swarm.agent.bind_pwa",
  ]);
  const fields = [
    "projectId",
    "teamName",
    "unassigned",
    "parentName",
    "roleClass",
    "path",
    "name",
    "role",
    "reportsTo",
    "actorPaseoAgentId",
    "agentId",
    "workspaceId",
    "pwaDirectory",
  ];
  function assertMixedRpcInput(input: Record<string, unknown>, method: string) {
    if (input.projectId !== undefined) expect(projects.has(input.projectId as string)).toBe(true);
    if (input.parentName !== undefined) expect(names.has(input.parentName as string)).toBe(true);
    if (input.reportsTo !== undefined && input.reportsTo !== null)
      expect(names.has(input.reportsTo as string)).toBe(true);
    if (method === "swarm.agent.prepare") expect(input.name).toBe("qa-mixed-supervisor");
    if (method === "swarm.agent.bind_workspace")
      expect(evidence.rpc.some((entry) => entry.prepared?.agentId === input.agentId)).toBe(true);
  }
  socket.on("framesent", ({ payload }) => {
    const raw = String(payload);
    if (!raw.includes('"plugin.rpc.invoke.request"') && !raw.includes('"workspace.create.request"'))
      return;
    try {
      const frame = JSON.parse(raw) as { message?: SessionInboundMessage } & SessionInboundMessage;
      const request = frame.message ?? frame;
      if (
        request.type === "plugin.rpc.invoke.request" &&
        request.pluginId === "paseo-swarm" &&
        methods.has(request.method)
      ) {
        const input = request.input as Record<string, unknown>;
        assertMixedRpcInput(input, request.method);
        expect(evidence.rpc.length, "Bounded mixed business ledger").toBeLessThan(128);
        const observed: MixedRpcObservation = {
          socketId,
          uri,
          requestId: request.requestId,
          method: request.method,
          input: Object.fromEntries(
            fields.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]),
          ),
          utc: new Date().toISOString(),
        };
        requests.set(request.requestId, observed);
        evidence.rpc.push(observed);
      }
      if (request.type !== "workspace.create.request" || !request.agent) return;
      const agent = request.agent;
      const prepared = evidence.rpc.find(
        (entry) => entry.prepared?.agentId === agent.agentId,
      )?.prepared;
      if (!prepared) throw new Error("Mixed UI workspace create has no matching observed prepare");
      expect(agent.config.systemPrompt).toBe(prepared.systemPrompt);
      expect(request.source.kind).toBe("worktree");
      expect(request.source.projectId).toBe(seeded.projectId);
      expect(evidence.creations.length, "One bounded private creation").toBeLessThan(4);
      const observed: MixedCreationObservation = {
        socketId,
        uri,
        requestId: request.requestId,
        agentId: prepared.agentId,
        systemPrompt: agent.config.systemPrompt!,
        sha256: createHash("sha256").update(agent.config.systemPrompt!).digest("hex"),
        bytes: Buffer.byteLength(agent.config.systemPrompt!, "utf8"),
        parentLabelPresent: Object.hasOwn(agent.labels ?? {}, "paseo.parent-agent-id"),
        parentLabel: agent.labels?.["paseo.parent-agent-id"],
        source: request.source,
        utc: new Date().toISOString(),
      };
      creations.set(request.requestId, observed);
      evidence.creations.push(observed);
    } catch (error) {
      ledger.errors.push(
        `Mixed sent-frame audit failed (${error instanceof Error ? error.name : typeof error})`,
      );
    }
  });
  socket.on("framereceived", ({ payload }) => {
    const raw = String(payload);
    if (
      ![
        "plugin.rpc.invoke.response",
        "workspace.create.response",
        "plugin.catalog.get.response",
        "rpc_error",
      ].some((type) => raw.includes(`"${type}"`))
    )
      return;
    try {
      const frame = JSON.parse(raw) as {
        message?: SessionOutboundMessage;
      } & SessionOutboundMessage;
      const response = frame.message ?? frame;
      if (response.type === "plugin.catalog.get.response") {
        expect(evidence.catalogs.length, "Bounded browser catalog ledger").toBeLessThan(16);
        evidence.catalogs.push({
          socketId,
          uri,
          requestId: response.payload.requestId,
          plugins: response.payload.plugins.map(({ id, clientBundle }) => ({
            id,
            clientBundleSha256: createHash("sha256").update(clientBundle).digest("hex"),
            clientBundleBytes: Buffer.byteLength(clientBundle, "utf8"),
          })),
        });
        return;
      }
      if (response.type === "workspace.create.response") {
        const created = creations.get(response.payload.requestId);
        if (created)
          created.response = {
            agentId: response.payload.agent?.id,
            workspaceId: response.payload.workspace?.id ?? null,
            error: response.payload.error,
          };
        return;
      }
      if (response.type !== "plugin.rpc.invoke.response" && response.type !== "rpc_error") return;
      const entry = requests.get(response.payload.requestId);
      if (!entry) return;
      entry.responseUtc = new Date().toISOString();
      if (response.type === "rpc_error") {
        entry.error = { code: response.payload.code };
        ledger.errors.push(`Mixed fixture business RPC failed ${entry.method}`);
        return;
      }
      recordMixedRpcOutput(entry, response.payload.output);
    } catch (error) {
      ledger.errors.push(
        `Mixed received-frame audit failed (${error instanceof Error ? error.name : typeof error})`,
      );
    }
  });
}

function mixedBundleUrl(url: URL): MixedBundleUrl {
  return {
    url: safeUrl(url.href),
    devValues: url.searchParams.getAll("dev"),
    minifyValues: url.searchParams.getAll("minify"),
    queryKeys: [...url.searchParams.keys()],
  };
}

async function recordMixedMainBundle(
  route: Route,
  response: APIResponse,
  evidence: { mixed: MixedRepairEvidence; metroOrigin: string; testInfo: TestInfo },
): Promise<MixedMainBundleObservation | undefined> {
  const request = route.request();
  const url = new URL(request.url());
  if (url.origin !== evidence.metroOrigin || url.pathname !== "/packages/app/index.ts.bundle")
    return;
  const responseUrl = new URL(response.url());
  expect(Boolean(responseUrl.username || responseUrl.password)).toBe(false);
  expect(responseUrl.origin).toBe(evidence.metroOrigin);
  expect(responseUrl.pathname).toBe(url.pathname);
  expect(evidence.mixed.mainBundles.length, "Bounded actual entry-bundle responses").toBeLessThan(
    16,
  );
  const sequence = evidence.mixed.mainBundles.length + 1;
  const entry: MixedMainBundleObservation = {
    sequence,
    kind: "main-entry-bundle",
    observedUtc: new Date().toISOString(),
    request: {
      ...mixedBundleUrl(url),
      method: request.method(),
      resourceType: request.resourceType(),
    },
    response: {
      ...mixedBundleUrl(responseUrl),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? null,
      sha256: null,
      bytes: null,
      bodyPath: evidence.testInfo.outputPath(`mixed-main-bundle-${sequence}.js`),
    },
    forwarded: false,
  };
  evidence.mixed.mainBundles.push(entry);
  const body = await response.body();
  entry.response.sha256 = createHash("sha256").update(body).digest("hex");
  entry.response.bytes = body.length;
  await writeFile(entry.response.bodyPath, body, { flag: "wx", mode: 0o600 });
  expect(entry.request.method).toBe("GET");
  expect(entry.request.resourceType).toBe("script");
  expect(entry.response.status).toBe(200);
  expect(entry.response.contentType).toMatch(/(?:java|ecma)script/i);
  expect(entry.response.bytes).toBeGreaterThan(0);
  if (evidence.mixed.pair === "old-app/current-core") {
    expect(entry.request.devValues).toEqual(["false"]);
    expect([[], ["false"]]).toContainEqual(entry.request.minifyValues);
    expect(entry.response.devValues).toEqual(["false"]);
    expect([[], ["false"]]).toContainEqual(entry.response.minifyValues);
  }
  return entry;
}

async function forwardOwnedHttp(
  route: Route,
  allowedOrigins: Set<string>,
  ledger: RepairLedger,
  bundleEvidence?: { mixed: MixedRepairEvidence; metroOrigin: string; testInfo: TestInfo },
) {
  const url = new URL(route.request().url());
  try {
    if (url.protocol === "data:" || url.protocol === "blob:") return await route.continue();
    const rejected = Boolean(url.username || url.password) || !allowedOrigins.has(url.origin);
    ledger.requests.push({
      kind: "http",
      url: safeUrl(url.href),
      rejected,
      method: route.request().method(),
    });
    if (rejected) {
      ledger.errors.push(`Rejected HTTP ${safeUrl(url.href)}`);
      return await route.abort("blockedbyclient");
    }
    const response = await route.fetch({ maxRedirects: 0 });
    const locations = response
      .headersArray()
      .filter((header) => header.name.toLowerCase() === "location");
    if (
      locations.length > 1 ||
      (response.status() >= 300 && response.status() < 400 && locations.length > 0)
    ) {
      ledger.requests.push({
        kind: "http-redirect",
        from: safeUrl(url.href),
        status: response.status(),
        locationCount: locations.length,
        rejected: true,
        reason: locations.length > 1 ? "multiple-location-headers" : "redirects-forbidden",
      });
      ledger.errors.push(
        `Rejected HTTP redirect response ${response.status()} ${safeUrl(url.href)} (${locations.length} Location headers)`,
      );
      return await route.abort("blockedbyclient");
    }
    const bundle = bundleEvidence
      ? await recordMixedMainBundle(route, response, bundleEvidence)
      : undefined;
    await route.fulfill({ response });
    if (bundle) bundle.forwarded = true;
  } catch (error) {
    ledger.errors.push(
      `HTTP forwarding failed ${safeUrl(url.href)} (${error instanceof Error ? error.name : typeof error})`,
    );
    try {
      await route.abort("failed");
    } catch (abortError) {
      ledger.errors.push(
        `HTTP abort failed ${safeUrl(url.href)} (${abortError instanceof Error ? abortError.name : typeof abortError})`,
      );
    }
  }
}

async function removePrivatePaths(
  root: string | undefined,
  repo: Awaited<ReturnType<typeof createTempGitRepo>> | undefined,
  foreign: Awaited<ReturnType<typeof createTempGitRepo>> | undefined,
  ledger: RepairLedger,
) {
  for (const owned of [repo, foreign]) {
    if (!owned) continue;
    try {
      await owned.cleanup();
      ledger.lifecycle.push({ phase: "private-path-removed", path: owned.path });
    } catch (error) {
      ledger.cleanup.push(String(error));
    }
  }
  if (root) {
    try {
      await rm(root, { recursive: true, force: true });
      ledger.lifecycle.push({ phase: "private-path-removed", path: root });
    } catch (error) {
      ledger.cleanup.push(String(error));
    }
  }
}

function restoreEnvironment(
  priorHome: string | undefined,
  priorPwa: string | undefined,
  priorServer: string | undefined,
) {
  if (priorHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = priorHome;
  if (priorPwa === undefined) delete process.env.PASEO_SWARM_PWA_ROOT;
  else process.env.PASEO_SWARM_PWA_ROOT = priorPwa;
  if (priorServer === undefined) delete process.env.E2E_SERVER_ID;
  else process.env.E2E_SERVER_ID = priorServer;
}

async function persistLedger(testInfo: TestInfo, ledger: RepairLedger, preserveOriginal: boolean) {
  try {
    await writeFile(
      testInfo.outputPath("swarm-repair-ledger.json"),
      JSON.stringify(ledger, null, 2),
    );
  } catch (error) {
    if (!preserveOriginal) throw error;
    console.error("SWARM_REPAIR_LEDGER_PERSIST_FAILED: original failure preserved");
  }
}

function ownedMetroUrl(baseURL: string | undefined) {
  if (!baseURL) throw new Error("Owned Metro baseURL is required");
  const metro = new URL(baseURL);
  if (
    !["localhost", "127.0.0.1"].includes(metro.hostname) ||
    protectedPorts.has(Number(metro.port))
  ) {
    throw new Error("Swarm repair requires an owned loopback Metro port");
  }
  return metro;
}

interface MixedSocketObservation {
  mixed: MixedRepairEvidence | undefined;
  seeded: Awaited<ReturnType<typeof seedLegacy>>;
  runningDaemon: Awaited<ReturnType<typeof privateDaemon>>;
  ledger: RepairLedger;
}

function installMixedSocketObserver(
  page: Page,
  { mixed, seeded, runningDaemon, ledger }: MixedSocketObservation,
) {
  if (mixed) {
    let socketId = 0;
    page.on("websocket", (socket) => {
      const url = new URL(socket.url());
      if (
        url.origin.replace(/^ws/, "http") === `http://127.0.0.1:${runningDaemon.port}` ||
        url.origin.replace(/^ws/, "http") === `http://localhost:${runningDaemon.port}`
      )
        observeMixedSocket(socket, ++socketId, mixed, seeded, ledger);
    });
  }
}

interface RepairResultAssertions {
  mixed: MixedRepairEvidence | undefined;
  plugins: Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>;
  ledger: RepairLedger;
  legacyRoot: string;
  originalPwa: Buffer;
  foreignPwaRoot: string;
  originalForeignPwa: Buffer | undefined;
}

async function assertRepairResults({
  mixed,
  plugins,
  ledger,
  legacyRoot,
  originalPwa,
  foreignPwaRoot,
  originalForeignPwa,
}: RepairResultAssertions) {
  if (mixed) {
    expect(
      mixed.mainBundles.length,
      "Browser must request the actual main entry bundle",
    ).toBeGreaterThan(0);
    for (const bundle of mixed.mainBundles) expect(bundle.forwarded).toBe(true);
    expect(
      mixed.catalogs.length,
      "Browser must receive the actual selected catalog",
    ).toBeGreaterThan(0);
    const nodeCatalog = plugins.map(({ id, clientBundle }) => ({
      id,
      clientBundleSha256: createHash("sha256").update(clientBundle).digest("hex"),
      clientBundleBytes: Buffer.byteLength(clientBundle, "utf8"),
    }));
    for (const catalog of mixed.catalogs) expect(catalog.plugins).toEqual(nodeCatalog);
  }
  expect(ledger.errors).toEqual([]);
  expect(await readFile(path.join(legacyRoot, "PWA.md"))).toEqual(originalPwa);
  if (mixed)
    expect(await readFile(path.join(foreignPwaRoot, "PWA.md"))).toEqual(originalForeignPwa);
}

function readFaultFrame<T>(message: string | Buffer): T | undefined {
  if (typeof message !== "string") return undefined;
  try {
    const value = JSON.parse(message) as { message?: T } & T;
    return value.message ?? value;
  } catch {
    return undefined;
  }
}

function faultIntentHash(intent: unknown) {
  return createHash("sha256")
    .update(
      JSON.stringify(intent, (_key, value: unknown) =>
        value && typeof value === "object" && !Array.isArray(value)
          ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
          : value,
      ),
    )
    .digest("hex");
}

async function installPreviewDeliveryObserver(
  page: Page,
  kind: RepairFaultKind,
  daemonPort: number,
) {
  if (kind !== "settings-preview") return;
  await page.addInitScript(
    ({ port }) => {
      const state: PreviewDeliverySnapshot = { armed: null, receipt: null, errors: [] };
      const target = window as PreviewObserverWindow;
      if (target.__paseoRepairPreviewDelivery)
        throw new Error("Duplicate private preview observer");
      target.__paseoRepairPreviewDelivery = state;
      const nativeAdd = EventTarget.prototype.addEventListener;
      const sockets = new WeakMap<WebSocket, { registrations: number }>();
      const origins = new Set([`ws://127.0.0.1:${port}`, `ws://localhost:${port}`]);

      async function recordReceipt(
        raw: string,
        requestId: string,
        uri: string,
        registrations: number,
      ) {
        const bytes = new TextEncoder().encode(raw);
        const receivedAt = performance.now();
        const receivedUtc = new Date().toISOString();
        const receipt: PreviewDeliveryReceipt = {
          requestId,
          uri,
          type: "plugin.rpc.invoke.response",
          sha256: "",
          bytes: bytes.byteLength,
          receivedUtc,
          receivedAt,
          messageListeners: registrations,
        };
        state.receipt = receipt;
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        receipt.sha256 = Array.from(new Uint8Array(digest), (value) =>
          value.toString(16).padStart(2, "0"),
        ).join("");
        function secondFrame() {
          receipt.secondFrameAt = performance.now();
          receipt.settled = true;
        }
        function firstFrame() {
          receipt.firstFrameAt = performance.now();
          requestAnimationFrame(secondFrame);
        }
        function scheduleFrame() {
          requestAnimationFrame(firstFrame);
        }
        // The earlier app listener resolves its real waiter synchronously. Text-response
        // continuations drain before rendering; frame callbacks follow that finite chain.
        queueMicrotask(scheduleFrame);
      }

      EventTarget.prototype.addEventListener = function (
        this: EventTarget,
        type: string,
        listener: EventListenerOrEventListenerObject | null,
        options?: boolean | AddEventListenerOptions,
      ) {
        // Register the original application listener first, unchanged, with its original options.
        nativeAdd.call(this, type, listener, options);
        if (type !== "message" || !listener || !(this instanceof WebSocket)) return;
        const url = new URL(this.url);
        if (url.username || url.password || !origins.has(url.origin) || url.pathname !== "/ws")
          return;
        const prior = sockets.get(this);
        if (prior) {
          prior.registrations += 1;
          return;
        }
        const observed = { registrations: 1 };
        sockets.set(this, observed);
        // Native EventTarget registration bypasses this wrapper for the observer itself.
        nativeAdd.call(this, "message", (event: Event) => {
          const data: unknown = (event as MessageEvent<unknown>).data;
          if (typeof data !== "string" || !state.armed) return;
          let value: {
            message?: { type?: string; payload?: { requestId?: string } };
            type?: string;
            payload?: { requestId?: string };
          };
          try {
            value = JSON.parse(data) as typeof value;
          } catch {
            return;
          }
          const message = value.message ?? value;
          if (
            message.type !== "plugin.rpc.invoke.response" ||
            message.payload?.requestId !== state.armed
          )
            return;
          if (state.receipt) {
            state.errors.push("Duplicate correlated preview receipt");
            return;
          }
          if (observed.registrations !== 1)
            state.errors.push("Unexpected daemon message listener count");
          void recordReceipt(
            data,
            state.armed,
            url.origin + url.pathname,
            observed.registrations,
          ).catch((error: unknown) => {
            state.errors.push(
              `Preview receipt failed (${error instanceof Error ? error.name : typeof error})`,
            );
          });
        });
      };
    },
    { port: daemonPort },
  );
}

async function releasePreviewAAndSettle(
  page: Page,
  entry: FaultRpcObservation,
  release: () => void,
) {
  expect(entry.method).toBe("swarm.pwa_source.read");
  expect(entry.held).toBe("preview-A");
  expect(entry.replySha256).toBeTruthy();
  expect(entry.replyBytes).toBeGreaterThan(0);
  await page.evaluate((requestId) => {
    const state = (window as PreviewObserverWindow).__paseoRepairPreviewDelivery;
    if (!state || state.armed || state.receipt || state.errors.length)
      throw new Error("Private preview observer is not fresh");
    state.armed = requestId;
  }, entry.requestId);
  release();
  await expect
    .poll(async () => {
      entry.pageDelivery = await page.evaluate(() => {
        const state = (window as PreviewObserverWindow).__paseoRepairPreviewDelivery;
        if (!state) throw new Error("Private preview observer missing");
        return state;
      });
      return entry.pageDelivery;
    })
    .toMatchObject({
      armed: entry.requestId,
      errors: [],
      receipt: {
        requestId: entry.requestId,
        uri: entry.uri,
        type: "plugin.rpc.invoke.response",
        sha256: entry.replySha256,
        bytes: entry.replyBytes,
        messageListeners: 1,
        settled: true,
      },
    });
  expect(entry.pageDelivery!.errors).toEqual([]);
  const receipt = entry.pageDelivery!.receipt!;
  expect(Number.isFinite(receipt.receivedAt)).toBe(true);
  expect(receipt.firstFrameAt).toBeGreaterThanOrEqual(receipt.receivedAt);
  expect(receipt.secondFrameAt).toBeGreaterThan(receipt.firstFrameAt!);
}

function createRepairFault(
  kind: Exclude<RepairFaultKind, "none">,
  seeded: Awaited<ReturnType<typeof seedLegacy>>,
  legacyRoot: string,
  collection: string,
  ledger: RepairLedger,
  expectedServerId: string,
) {
  const evidence: RepairFaultEvidence = {
    kind,
    rpc: [],
    creations: [],
    sockets: [],
    disconnects: [],
    events: [],
  };
  ledger.lifecycle.push({ phase: "fault-acceptance", evidence });
  const requests = new Map<string, FaultRpcObservation>();
  const creations = new Map<string, FaultCreationObservation>();
  const holds = new Map<string, () => void>();
  const coldCohorts = new Map<ColdFaultLabel, ColdFaultCohort>();
  const pending = new Set<Promise<void>>();
  let holdMode: "preview" | "cold" | null = null;
  let disconnect: "preview" | "bind" | null = null;
  let closing = false;
  let deliverySequence = 0;
  const event = (action: string, label?: string, entry?: FaultRpcObservation) =>
    evidence.events.push({
      utc: new Date().toISOString(),
      action,
      label,
      requestId: entry?.requestId,
      socketId: entry?.socketId,
    });
  const latch = (error: unknown) => {
    ledger.errors.push(
      `Fault handler failed (${error instanceof Error ? error.name : typeof error})`,
    );
  };
  const track = (operation: Promise<void>) => {
    const settled = operation.catch(latch).finally(() => pending.delete(settled));
    pending.add(settled);
  };
  const release = (label: string) => {
    const forward = holds.get(label);
    expect(forward, `Real reply ${label} must already be held`).toBeDefined();
    holds.delete(label);
    forward!();
  };
  function coldLabel(method: string, input: Record<string, unknown>): ColdFaultLabel | undefined {
    if (method === "swarm.pwa_source.read" && input.path === undefined) return "cold-source";
    if (method === "swarm.board.read" && Object.keys(input).length === 0) return "cold-board";
    return undefined;
  }

  function coldCohort(entry: FaultRpcObservation) {
    if (entry.held === "cold-source" || entry.held === "cold-board")
      return coldCohorts.get(entry.held);
    return undefined;
  }

  function enrollCold(entry: FaultRpcObservation, label: ColdFaultLabel | undefined) {
    if (!label || coldCohorts.size === 0) return;
    const cohort = coldCohorts.get(label)!;
    if (cohort.released) {
      event("cold-read-after-release", label, entry);
      return;
    }
    expect(closing).toBe(false);
    expect(cohort.members.has(entry.requestId)).toBe(false);
    entry.held = label;
    cohort.members.set(entry.requestId, entry);
    event("cold-enrolled", label, entry);
  }

  function holdColdReply(
    entry: FaultRpcObservation,
    message: string | Buffer,
    forward: () => void,
  ) {
    const cohort = coldCohort(entry);
    if (!cohort) return false;
    expect(cohort.members.get(entry.requestId)).toBe(entry);
    expect(cohort.replies.has(entry.requestId)).toBe(false);
    const frame = typeof message === "string" ? Buffer.from(message, "utf8") : Buffer.from(message);
    cohort.replies.set(entry.requestId, { frame, forward });
    event("cold-reply-received", entry.held, entry);
    if (closing) {
      ledger.errors.push("Cold reply arrived during cleanup before successful forwarding");
      forward();
    } else if (cohort.released) {
      event("reply-after-release", entry.held, entry);
      forward();
    } else event("reply-held", entry.held, entry);
    return true;
  }

  function releaseCold(label: ColdFaultLabel) {
    const cohort = coldCohorts.get(label);
    expect(cohort).toBeDefined();
    expect(closing).toBe(false);
    expect(cohort!.released).toBe(false);
    expect(cohort!.replies.size).toBeGreaterThan(0);
    // Seal membership and authorize all its in-flight responses before any real send.
    cohort!.released = true;
    event("cold-release", label);
    for (const reply of cohort!.replies.values()) reply.forward();
  }

  function eventPositions(action: string, label: ColdFaultLabel, entry?: FaultRpcObservation) {
    return evidence.events.flatMap((row, index) =>
      row.action === action &&
      row.label === label &&
      (!entry || (row.requestId === entry.requestId && row.socketId === entry.socketId))
        ? [index]
        : [],
    );
  }

  function assertColdMember(
    label: ColdFaultLabel,
    cohort: ColdFaultCohort,
    entry: FaultRpcObservation,
    released: number,
  ) {
    expect(requests.get(entry.requestId)).toBe(entry);
    expect(evidence.rpc.filter((row) => row.requestId === entry.requestId)).toEqual([entry]);
    expect(entry.held).toBe(label);
    expect(entry.dispatched).toBe(true);
    expect(entry.replyForwarded).toBe(true);
    expect(entry.error).toBeUndefined();
    expect(entry.responseUtc).toBeDefined();
    const socket = evidence.sockets.find((row) => row.id === entry.socketId)!;
    expect(socket.uri).toBe(entry.uri);
    expect(socket.serverId).toBe(expectedServerId);
    const reply = cohort.replies.get(entry.requestId)!;
    expect(reply.frame.length).toBeGreaterThan(0);
    expect(entry.replyBytes).toBe(reply.frame.length);
    expect(entry.replySha256).toBe(createHash("sha256").update(reply.frame).digest("hex"));
    if (label === "cold-source") {
      expect(entry.method).toBe("swarm.pwa_source.read");
      expect(entry.source?.path).toBe(legacyRoot);
    } else {
      expect(entry.method).toBe("swarm.board.read");
      expect(entry.input).toEqual({});
      expect(entry.board?.taskIds).toEqual(seeded.state.tasks.map((row) => row.id).sort());
      expect(entry.board?.activityIds).toEqual(seeded.state.activities.map((row) => row.id).sort());
    }
    const enrolled = eventPositions("cold-enrolled", label, entry);
    const received = eventPositions("cold-reply-received", label, entry);
    const forwarded = eventPositions("reply-forwarded", label, entry);
    expect(enrolled).toHaveLength(1);
    expect(received).toHaveLength(1);
    expect(forwarded).toHaveLength(1);
    expect(enrolled[0]!).toBeLessThan(released);
    expect(enrolled[0]!).toBeLessThan(received[0]!);
    expect(forwarded[0]!).toBeGreaterThan(released);
    expect(forwarded[0]!).toBeGreaterThan(received[0]!);
    expect(eventPositions("reply-cleanup-forwarded", label, entry)).toEqual([]);
    const held = eventPositions("reply-held", label, entry);
    const late = eventPositions("reply-after-release", label, entry);
    if (received[0]! < released) {
      expect(held).toHaveLength(1);
      expect(held[0]!).toBeGreaterThan(received[0]!);
      expect(held[0]!).toBeLessThan(released);
      expect(late).toEqual([]);
    } else {
      expect(held).toEqual([]);
      expect(late).toHaveLength(1);
      expect(late[0]!).toBeGreaterThan(received[0]!);
      expect(late[0]!).toBeLessThan(forwarded[0]!);
    }
  }

  function assertColdComplete() {
    expect(evidence.events.filter((row) => row.action === "cold-target-armed")).toHaveLength(1);
    expect([...coldCohorts.keys()]).toEqual(["cold-source", "cold-board"]);
    for (const [label, cohort] of coldCohorts) {
      expect(cohort.released).toBe(true);
      expect(cohort.members.size).toBeGreaterThan(0);
      expect([...cohort.members.keys()].sort()).toEqual(
        evidence.rpc
          .filter((row) => row.held === label)
          .map((row) => row.requestId)
          .sort(),
      );
      expect([...cohort.replies.keys()].sort()).toEqual([...cohort.members.keys()].sort());
      const released = eventPositions("cold-release", label);
      expect(released).toHaveLength(1);
      for (const entry of cohort.members.values())
        assertColdMember(label, cohort, entry, released[0]!);
    }
  }

  async function settleColdCohorts() {
    expect([...coldCohorts.keys()]).toEqual(["cold-source", "cold-board"]);
    for (const cohort of coldCohorts.values()) expect(cohort.released).toBe(true);
    await expect
      .poll(() =>
        [...coldCohorts.values()].every((cohort) =>
          [...cohort.members.values()].every((entry) => entry.replyForwarded === true),
        ),
      )
      .toBe(true);
    assertColdComplete();
  }

  function assertColdTargetHealthy() {
    expect(kind).toBe("wizard-bind");
    expect(closing).toBe(false);
    expect(ledger.errors).toEqual([]);
    expect(ledger.cleanup).toEqual([]);
    expect(evidence.disconnects).toEqual([]);
    expect(evidence.sockets.every((row) => !row.pageClosed && !row.serverClosed)).toBe(true);
    expect([...coldCohorts.keys()]).toEqual(["cold-source", "cold-board"]);
    for (const [label, cohort] of coldCohorts) {
      expect(cohort.released).toBe(false);
      expect(cohort.members.size).toBeGreaterThan(0);
      expect(cohort.replies.size).toBeGreaterThan(0);
      expect(eventPositions("cold-release", label)).toEqual([]);
      for (const entry of cohort.members.values()) {
        expect(entry.dispatched).toBe(true);
        expect(entry.replyForwarded).toBeUndefined();
      }
    }
  }

  function flushColdForCleanup() {
    for (const cohort of coldCohorts.values()) {
      for (const [id, reply] of cohort.replies) {
        if (cohort.members.get(id)!.replyForwarded) continue;
        try {
          reply.forward();
        } catch (error) {
          latch(error);
        }
      }
    }
  }

  const methods = new Set([
    "swarm.board.read",
    "swarm.pwa_source.read",
    "swarm.pwa_roles.read",
    "swarm.pwa_source.set",
    "swarm.agent.prepare",
    "swarm.agent.bind_workspace",
    "swarm.agent.bind_pwa",
  ]);
  const fields = [
    "projectId",
    "path",
    "teamName",
    "parentName",
    "name",
    "roleClass",
    "role",
    "reportsTo",
    "agentId",
    "workspaceId",
    "pwaDirectory",
  ];

  function observeRpc(
    request: Extract<SessionInboundMessage, { type: "plugin.rpc.invoke.request" }>,
    socketId: number,
    uri: string,
  ) {
    const input = request.input as Record<string, unknown>;
    // Qualification uses the actual raw input, before privacy-oriented field projection.
    const eligibleColdLabel = coldLabel(request.method, input);
    if (input.projectId !== undefined) expect(input.projectId).toBe(seeded.projectId);
    expect(requests.has(request.requestId), "Unique correlated fault request").toBe(false);
    expect(evidence.rpc.length).toBeLessThan(128);
    const entry: FaultRpcObservation = {
      socketId,
      uri,
      requestId: request.requestId,
      method: request.method,
      input: Object.fromEntries(
        fields.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]),
      ),
      utc: new Date().toISOString(),
      dispatched: false,
    };
    requests.set(request.requestId, entry);
    evidence.rpc.push(entry);
    expect(
      ["swarm.pwa_source.set", "swarm.agent.bind_pwa"].includes(request.method),
      "No save or parent rebind in fault cases",
    ).toBe(false);
    if (request.method === "swarm.agent.prepare") {
      expect(kind).toBe("wizard-bind");
      expect(input.name).toBe("qa-fault-supervisor");
      expect(input.reportsTo).toBe("qa-planner");
      expect(input.roleClass).toBe("supervisor");
    }
    if (holdMode === "preview" && request.method === "swarm.pwa_source.read") {
      if (input.path === collection) entry.held = "preview-A";
      if (input.path === legacyRoot) entry.held = "preview-B";
    }
    enrollCold(entry, eligibleColdLabel);
    if (entry.held === "preview-A" || entry.held === "preview-B")
      expect(evidence.rpc.filter((row) => row.held === entry.held)).toHaveLength(1);
    return entry;
  }

  function observeCreation(
    request: Extract<SessionInboundMessage, { type: "workspace.create.request" }>,
    socketId: number,
    uri: string,
  ) {
    const agent = request.agent;
    expect(kind).toBe("wizard-bind");
    expect(agent).toBeDefined();
    const prepared = evidence.rpc.find(
      (entry) => entry.prepared?.agentId === agent?.agentId,
    )?.prepared;
    expect(prepared, "Native creation must follow actual prepared response").toBeDefined();
    expect(agent!.config.systemPrompt).toBe(prepared!.systemPrompt);
    expect(agent!.labels?.["paseo.parent-agent-id"]).toBe(
      seeded.agents.find((row) => row.qualifiedName === "qa-planner")!.paseoAgentId,
    );
    expect(request.source.kind).toBe("worktree");
    expect(request.source.projectId).toBe(seeded.projectId);
    expect(request.idempotencyKey).toBeTruthy();
    expect(evidence.creations.length).toBeLessThan(2);
    const { requestId: _requestId, ...intent } = request;
    const observed: FaultCreationObservation = {
      socketId,
      uri,
      requestId: request.requestId,
      agentId: prepared!.agentId,
      systemPrompt: agent!.config.systemPrompt!,
      sha256: prepared!.sha256,
      bytes: prepared!.bytes,
      parentLabelPresent: Object.hasOwn(agent!.labels ?? {}, "paseo.parent-agent-id"),
      parentLabel: agent!.labels?.["paseo.parent-agent-id"],
      source: request.source,
      utc: new Date().toISOString(),
      idempotencyKey: request.idempotencyKey,
      intentSha256: faultIntentHash(intent),
    };
    creations.set(request.requestId, observed);
    evidence.creations.push(observed);
  }

  function shouldDisconnect(entry: FaultRpcObservation) {
    if (disconnect === "preview")
      return entry.method === "swarm.pwa_source.read" && entry.input.path === collection;
    if (disconnect === "bind") {
      if (entry.method !== "swarm.agent.bind_workspace") return false;
      const prepared = evidence.rpc.filter((row) => row.prepared);
      expect(prepared).toHaveLength(1);
      expect(entry.input.agentId).toBe(prepared[0]!.prepared!.agentId);
      expect(evidence.creations[0]?.response?.workspaceId).toBe(entry.input.workspaceId);
      return true;
    }
    return false;
  }

  function receiveReply(message: string | Buffer, socket: WebSocketRoute, socketId: number) {
    const response = readFaultFrame<SessionOutboundMessage>(message);
    if (response?.type === "workspace.create.response") {
      const created = creations.get(response.payload.requestId);
      if (created)
        created.response = {
          agentId: response.payload.agent?.id,
          workspaceId: response.payload.workspace?.id ?? null,
          error: response.payload.error,
        };
    }
    if (response?.type !== "plugin.rpc.invoke.response" && response?.type !== "rpc_error") {
      socket.send(message);
      return;
    }
    const entry = requests.get(response.payload.requestId);
    if (!entry) {
      socket.send(message);
      return;
    }
    expect(entry.socketId, "Reply must use the original request socket").toBe(socketId);
    expect(entry.dispatched, "No server reply for the before-dispatch rejected request").toBe(true);
    expect(entry.responseUtc, "Exactly one actual correlated reply").toBeUndefined();
    entry.responseUtc = new Date().toISOString();
    entry.replySha256 = createHash("sha256").update(message).digest("hex");
    entry.replyBytes = Buffer.byteLength(message);
    const forward = () => {
      expect(entry.replyForwarded, "Exactly one original-socket forward").toBeUndefined();
      socket.send(message);
      entry.replyForwarded = true;
      entry.deliverySequence = ++deliverySequence;
      event(
        closing && coldCohort(entry) ? "reply-cleanup-forwarded" : "reply-forwarded",
        entry.held,
        entry,
      );
    };
    if (response.type === "rpc_error") {
      entry.error = { code: response.payload.code };
      if (coldCohort(entry)) {
        ledger.errors.push("Unexpected actual plugin RPC error during fault acceptance");
        holdColdReply(entry, message, forward);
        return;
      }
      forward();
      ledger.errors.push("Unexpected actual plugin RPC error during fault acceptance");
      return;
    }
    try {
      recordMixedRpcOutput(entry, response.payload.output);
    } catch (error) {
      latch(error);
    }
    if (holdColdReply(entry, message, forward)) return;
    if (!entry.held) forward();
    else {
      expect(holds.has(entry.held)).toBe(false);
      holds.set(entry.held, forward);
      event("reply-held", entry.held, entry);
    }
  }

  function attach(socket: WebSocketRoute) {
    expect(evidence.sockets.length).toBeLessThan(12);
    const row: RepairFaultEvidence["sockets"][number] = {
      id: evidence.sockets.length + 1,
      uri: safeUrl(socket.url()),
      pageClosed: false,
      serverClosed: false,
      received: 0,
    };
    evidence.sockets.push(row);
    const server = socket.connectToServer();
    const expectedClose = () =>
      closing || evidence.disconnects.some((entry) => entry.socketId === row.id);
    socket.onClose((code, reason) => {
      row.pageClosed = true;
      if (!expectedClose()) ledger.errors.push(`Unexpected fault page WS close ${row.id}`);
      if (!row.serverClosed) track(server.close({ code, reason }));
    });
    server.onClose((code, reason) => {
      row.serverClosed = true;
      if (!expectedClose()) ledger.errors.push(`Unexpected fault server WS close ${row.id}`);
      if (!row.pageClosed) track(socket.close({ code, reason }));
    });
    socket.onMessage((message) => {
      try {
        const request = readFaultFrame<SessionInboundMessage>(message);
        if (
          request?.type === "send_agent_message_request" ||
          request?.type === "cancel_agent_request"
        )
          throw new Error("Unexpected send/cancel in fault acceptance");
        if (request?.type === "workspace.create.request") observeCreation(request, row.id, row.uri);
        if (request?.type === "plugin.rpc.invoke.request" && request.pluginId === "paseo-swarm") {
          expect(methods.has(request.method), "No additional fault business mutation").toBe(true);
          const entry = observeRpc(request, row.id, row.uri);
          if (shouldDisconnect(entry)) {
            expect(evidence.disconnects).toHaveLength(0);
            const planned = {
              socketId: row.id,
              requestId: entry.requestId,
              method: entry.method,
              reason: `QA planned ${disconnect} disconnect`,
              beforeDispatch: true as const,
              closeRequested: false,
            };
            evidence.disconnects.push(planned);
            disconnect = null;
            event("request-not-dispatched", undefined, entry);
            // Close the real owned server socket; its actual close event closes the page side.
            track(
              server.close({ code: 4001, reason: planned.reason }).then(() => {
                planned.closeRequested = true;
                return undefined;
              }),
            );
            return;
          }
          entry.dispatched = true;
        }
        server.send(message);
      } catch (error) {
        latch(error);
        track(server.close({ code: 4003, reason: "Fault contract rejected" }));
      }
    });
    server.onMessage((message) => {
      try {
        row.received += 1;
        const response = readFaultFrame<SessionOutboundMessage>(message);
        if (response?.type === "status" && response.payload.status === "server_info") {
          expect(response.payload.serverId).toBe(expectedServerId);
          row.serverId = expectedServerId;
        }
        receiveReply(message, socket, row.id);
      } catch (error) {
        latch(error);
      }
    });
  }

  const control: RepairFaultControl = {
    evidence,
    holdPreviewOrder() {
      expect(kind).toBe("settings-preview");
      expect(holdMode).toBeNull();
      holdMode = "preview";
      event("preview-order-armed");
    },
    holdColdTarget() {
      expect(kind).toBe("wizard-bind");
      expect(holdMode).toBeNull();
      expect(coldCohorts.size).toBe(0);
      coldCohorts.set("cold-source", { released: false, members: new Map(), replies: new Map() });
      coldCohorts.set("cold-board", { released: false, members: new Map(), replies: new Map() });
      holdMode = "cold";
      event("cold-target-armed");
    },
    release(label) {
      if (label === "cold-source" || label === "cold-board") {
        releaseCold(label);
        return;
      }
      release(label);
      if (holds.size === 0) holdMode = null;
    },
    async releasePreviewAAndSettle(page) {
      expect(kind).toBe("settings-preview");
      const entry = evidence.rpc.find((row) => row.held === "preview-A");
      expect(entry).toBeDefined();
      await releasePreviewAAndSettle(page, entry!, () => control.release("preview-A"));
    },
    disconnectNextPreview() {
      expect(kind).toBe("settings-preview");
      expect(holds.size).toBe(0);
      expect(disconnect).toBeNull();
      disconnect = "preview";
      event("preview-disconnect-armed");
    },
    async disconnectNextBind() {
      expect(kind).toBe("wizard-bind");
      // Finish sealed in-flight replies before deliberately closing their original socket.
      await settleColdCohorts();
      expect(holds.size).toBe(0);
      expect(disconnect).toBeNull();
      disconnect = "bind";
      event("bind-disconnect-armed");
    },
    assertColdTargetHealthy,
    reconnectObserved() {
      const closed = evidence.disconnects[0];
      const prior = evidence.sockets.find((row) => row.id === closed?.socketId);
      return Boolean(
        prior?.pageClosed &&
        prior.serverClosed &&
        evidence.sockets.some((row) => row.id > prior.id && row.serverId === expectedServerId),
      );
    },
  };
  return {
    control,
    attach,
    async complete() {
      if (kind === "wizard-bind") await settleColdCohorts();
      expect(evidence.disconnects).toHaveLength(1);
      expect(disconnect).toBeNull();
      expect(holds.size).toBe(0);
      expect(evidence.disconnects[0]!.closeRequested).toBe(true);
      for (const entry of evidence.rpc.filter((row) => row.held))
        expect(entry.replyForwarded).toBe(true);
    },
    beforeClose() {
      closing = true;
      if (
        holds.size ||
        disconnect ||
        [...coldCohorts.values()].some((cohort) => !cohort.released) ||
        evidence.rpc.some((entry) => entry.held && !entry.replyForwarded)
      )
        ledger.errors.push("Fault holds or armed disconnect left unfinished");
      for (const label of holds.keys()) release(label);
      flushColdForCleanup();
    },
    async settled() {
      await expect
        .poll(
          () =>
            pending.size === 0 &&
            evidence.sockets.every((row) => row.pageClosed && row.serverClosed),
        )
        .toBe(true);
      expect(holds.size).toBe(0);
      expect(evidence.sockets.length).toBeGreaterThan(1);
      if (kind === "wizard-bind") assertColdComplete();
    },
  };
}

type FaultRuntime = ReturnType<typeof createRepairFault>;

function assertFaultPair(kind: RepairFaultKind, pair: RepairPair) {
  if (kind !== "none") expect(pair).toBe("repair/repair");
}

function optionalRepairFault(
  kind: RepairFaultKind,
  seeded: Awaited<ReturnType<typeof seedLegacy>>,
  legacyRoot: string,
  collection: string,
  ledger: RepairLedger,
  serverId: string,
) {
  return kind === "none"
    ? undefined
    : createRepairFault(kind, seeded, legacyRoot, collection, ledger, serverId);
}

function connectRepairSocket(
  socket: WebSocketRoute,
  allowedOrigins: Set<string>,
  port: number,
  ledger: RepairLedger,
  fault: FaultRuntime | undefined,
) {
  const url = new URL(socket.url());
  const origin = url.origin.replace(/^ws/, "http");
  const rejected = Boolean(url.username || url.password) || !allowedOrigins.has(origin);
  ledger.requests.push({ kind: "ws", url: safeUrl(url.href), rejected });
  if (rejected) {
    ledger.errors.push(`Rejected WS ${safeUrl(url.href)}`);
    void socket.close({ code: 1008, reason: "Outside private repair scope" });
  } else if (
    fault &&
    [`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(origin) &&
    url.pathname === "/ws"
  )
    fault.attach(socket);
  else socket.connectToServer();
}

function beginFaultClose(fault: FaultRuntime | undefined, ledger: RepairLedger) {
  try {
    fault?.beforeClose();
  } catch (error) {
    ledger.cleanup.push(
      `Fault hold release: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

function repairFaultControl(fault: FaultRuntime | undefined) {
  return fault?.control;
}

async function completeRepairFault(fault: FaultRuntime | undefined) {
  await fault?.complete();
}

async function settleFaultClose(fault: FaultRuntime | undefined, ledger: RepairLedger) {
  try {
    await fault?.settled();
  } catch (error) {
    ledger.cleanup.push(
      `Fault terminal closure: ${error instanceof Error ? error.name : typeof error}`,
    );
  }
}

export const repairTest = metroTest.extend<{
  repair: RepairDaemon;
  repairPair: RepairPair;
  repairFault: RepairFaultKind;
}>({
  repairPair: ["repair/repair", { option: true }],
  repairFault: ["none", { option: true }],
  repair: async ({ page, context, baseURL, repairPair, repairFault }, runFixture, testInfo) => {
    const metro = ownedMetroUrl(baseURL);
    const priorHome = process.env.PASEO_HOME;
    const priorPwa = process.env.PASEO_SWARM_PWA_ROOT;
    const priorServer = process.env.E2E_SERVER_ID;
    const ledger: RepairLedger = {
      lifecycle: [],
      requests: [],
      errors: [],
      cleanup: [],
    };
    let daemon: Awaited<ReturnType<typeof privateDaemon>> | undefined;
    let client: DaemonClient | undefined;
    let closingContext = false;
    let primaryFailed = false;
    let root: string | undefined;
    let repo: Awaited<ReturnType<typeof createTempGitRepo>> | undefined;
    let foreign: Awaited<ReturnType<typeof createTempGitRepo>> | undefined;
    let fault: ReturnType<typeof createRepairFault> | undefined;
    try {
      assertFaultPair(repairFault, repairPair);
      const { coreRoot, mixed } = await mixedRoots(repairPair, testInfo, ledger);
      root = await mkdtemp(path.join(tmpdir(), "swarm-repair-"));
      ledger.lifecycle.push({ phase: "private-root-created", path: root });
      repo = await createTempGitRepo("swarm-repair-project-");
      ledger.lifecycle.push({ phase: "private-repo-created", path: repo.path });
      foreign = await createTempGitRepo("swarm-repair-foreign-");
      ledger.lifecycle.push({ phase: "private-foreign-repo-created", path: foreign.path });
      process.env.PASEO_HOME = path.join(root, "home", ".paseo");
      delete process.env.PASEO_SWARM_PWA_ROOT;
      const collection = path.join(repo.path, "pwas");
      const legacyRoot = path.join(collection, "legacy");
      const missingRoot = path.join(repo.path, "not-present");
      await pwa(legacyRoot, "Legacy", ["survey", "completed"], false);
      const foreignPwaRoot = path.join(foreign.path, "pwas", "legacy");
      if (mixed) await pwa(foreignPwaRoot, "Foreign", ["survey", "completed"], false);
      await pwa(path.join(collection, "alternate"), "Alternate", ["queued", "completed"], true);
      await mkdir(path.join(collection, "broken"), { recursive: true });
      await writeFile(
        path.join(collection, "broken", "PWA.md"),
        "---\ninvalid: true\n---\nBroken entry.\n",
      );
      // A real depth limit makes partial discovery reproducible without permission mocks.
      await mkdir(path.join(collection, "depth", ...Array<string>(9).fill("child")), {
        recursive: true,
      });
      daemon = await privateDaemon(root, metro.origin, false, coreRoot);
      ledger.lifecycle.push({
        phase: "bootstrap-start",
        port: daemon.port,
        pid: process.pid,
        serverId: daemon.daemon.getServerId(),
        listen: daemon.daemon.getListenTarget(),
        home: daemon.paseoHome,
        utc: new Date().toISOString(),
      });
      client = await connect(daemon.port, coreRoot);
      const seeded = await seedLegacy(client, repo.path, foreign.path, collection, Boolean(mixed));
      await client.close();
      client = undefined;
      await stopDaemon(daemon.daemon);
      ledger.lifecycle.push({
        phase: "bootstrap-stop-flush",
        port: daemon.port,
        utc: new Date().toISOString(),
      });
      daemon = undefined;
      const dataRoot = path.join(root, "home", ".paseo", "plugin-data", "paseo-swarm");
      await mkdir(dataRoot, { recursive: true });
      await writeFile(path.join(dataRoot, "state.json"), JSON.stringify(seeded.state));
      const configPath = path.join(dataRoot, "config.json");
      await writeFile(
        configPath,
        JSON.stringify({
          projectSources: {
            [seeded.projectId]: legacyRoot,
            ...(mixed
              ? {
                  [seeded.agents.find((agent) => agent.qualifiedName === "qa-planner-outsider")!
                    .projectId!]: foreignPwaRoot,
                }
              : {}),
          },
          keepUnknown: "retained",
        }),
      );
      const originalPwa = await readFile(path.join(legacyRoot, "PWA.md"));
      const originalForeignPwa = mixed
        ? await readFile(path.join(foreignPwaRoot, "PWA.md"))
        : undefined;
      if (mixed)
        ledger.lifecycle.push({
          phase: "mixed-legacy-pwa",
          directory: foreignPwaRoot,
          sha256: createHash("sha256").update(originalForeignPwa!).digest("hex"),
          noExplicitBindings: seeded.agents.every((agent) => agent.pwaBinding === undefined),
        });
      ledger.lifecycle.push({
        phase: "legacy-seeded-before-plugin-start",
        sha256: createHash("sha256").update(originalPwa).digest("hex"),
        state: seeded.state,
      });
      daemon = await privateDaemon(root, metro.origin, true, coreRoot);
      ledger.lifecycle.push({
        phase: "swarm-start",
        port: daemon.port,
        pid: process.pid,
        serverId: daemon.daemon.getServerId(),
        listen: daemon.daemon.getListenTarget(),
        home: daemon.paseoHome,
        utc: new Date().toISOString(),
      });
      client = await connect(daemon.port, coreRoot);
      const runningClient = client;
      const runningDaemon = daemon;
      const serverId = daemon.daemon.getServerId();
      process.env.E2E_SERVER_ID = serverId;
      const invoke = (method: string, input: unknown) =>
        runningClient.invokePluginRpc("paseo-swarm", method, input);
      const plugins = await client.getPluginCatalog();
      ledger.lifecycle.push({
        phase: "catalog",
        plugins: plugins.map(({ id, clientBundle }) => ({
          id,
          clientBundleSha256: createHash("sha256").update(clientBundle).digest("hex"),
          clientBundleBytes: Buffer.byteLength(clientBundle, "utf8"),
        })),
      });
      if (!plugins.some((plugin) => plugin.id === "paseo-swarm")) {
        ledger.lifecycle.push({
          phase: "catalog-missing-logs",
          entries: await client.getPluginLogs("paseo-swarm"),
        });
      }
      expect(plugins.some((plugin) => plugin.id === "paseo-swarm")).toBe(true);
      const board = boardReadRpc.output.parse(await invoke(boardReadRpc.name, {}));
      expect(board.tasks.map((task) => task.id).sort()).toEqual(
        seeded.state.tasks.map((task) => task.id).sort(),
      );
      expect(board.agents.find((agent) => agent.name === "qa-planner")?.pwaBinding).toBeUndefined();
      const source = pwaSourceReadRpc.output.parse(
        await invoke(pwaSourceReadRpc.name, { projectId: seeded.projectId }),
      );
      expect(source.path).toBe(legacyRoot);
      const allowedOrigins = new Set([
        metro.origin,
        `http://127.0.0.1:${daemon.port}`,
        `http://localhost:${daemon.port}`,
      ]);
      fault = optionalRepairFault(repairFault, seeded, legacyRoot, collection, ledger, serverId);
      await installPreviewDeliveryObserver(page, repairFault, runningDaemon.port);
      await context.route("**/*", (route) =>
        forwardOwnedHttp(
          route,
          allowedOrigins,
          ledger,
          mixed ? { mixed, metroOrigin: metro.origin, testInfo } : undefined,
        ),
      );
      await context.routeWebSocket(/.*/, (socket) =>
        connectRepairSocket(socket, allowedOrigins, runningDaemon.port, ledger, fault),
      );
      installMixedSocketObserver(page, { mixed, seeded, runningDaemon, ledger });
      page.on("pageerror", (error) => ledger.errors.push(error.name));
      page.on("requestfailed", (request) => {
        const failure = request.failure()?.errorText;
        ledger.requests.push({
          kind: "requestfailed",
          url: safeUrl(request.url()),
          failure,
          closingContext,
        });
        if (!(closingContext && failure === "net::ERR_ABORTED"))
          ledger.errors.push(`Request failed ${safeUrl(request.url())}`);
      });
      page.on("response", (response) => {
        if (response.status() >= 400)
          ledger.errors.push(`HTTP ${response.status()} ${safeUrl(response.url())}`);
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
            endpoint: `127.0.0.1:${daemon.port}`,
            nowIso: new Date().toISOString(),
          }),
          preferences: { provider: "claude", providerPreferences: TEST_PROVIDER_PREFERENCES },
        },
      );
      await runFixture({
        root,
        client,
        serverId,
        port: daemon.port,
        ...seeded,
        initial: seeded.state,
        repo: repo.path,
        legacyRoot,
        collection,
        missingRoot,
        configPath,
        invoke,
        nativePrompt: (id) => runningDaemon.daemon.agentManager.getAgent(id)?.config.systemPrompt,
        mixed,
        fault: repairFaultControl(fault),
        recordMixedEvidence: (entry) => ledger.lifecycle.push({ phase: "mixed-assertion", entry }),
      });
      await completeRepairFault(fault);
      await assertRepairResults({
        mixed,
        plugins,
        ledger,
        legacyRoot,
        originalPwa,
        foreignPwaRoot,
        originalForeignPwa,
      });
    } catch (error) {
      primaryFailed = true;
      throw error;
    } finally {
      if (primaryFailed || testInfo.status !== testInfo.expectedStatus) {
        try {
          await page.screenshot({ path: testInfo.outputPath("swarm-repair-first-failure.png") });
          await writeFile(
            testInfo.outputPath("swarm-repair-first-failure.html"),
            await page.content(),
          );
        } catch (error) {
          ledger.cleanup.push(`Failure capture: ${String(error)}`);
        }
      }
      closingContext = true;
      beginFaultClose(fault, ledger);
      try {
        await context.close();
      } catch (error) {
        ledger.cleanup.push(`Browser close: ${String(error)}`);
      }
      await settleFaultClose(fault, ledger);
      if (client) {
        try {
          await client.close();
        } catch (error) {
          ledger.cleanup.push(`Client close: ${String(error)}`);
        }
      }
      if (daemon) {
        try {
          await stopDaemon(daemon.daemon);
          ledger.lifecycle.push({
            phase: "swarm-stop-flush",
            port: daemon.port,
            utc: new Date().toISOString(),
          });
        } catch (error) {
          ledger.cleanup.push(String(error));
        }
      }
      restoreEnvironment(priorHome, priorPwa, priorServer);
      if (ledger.cleanup.length === 0) {
        await removePrivatePaths(root, repo, foreign, ledger);
      }
      await persistLedger(
        testInfo,
        ledger,
        primaryFailed || testInfo.status !== testInfo.expectedStatus,
      );
    }
    if (!primaryFailed && testInfo.status === testInfo.expectedStatus) {
      expect(ledger.errors, "Private network/page terminal errors").toEqual([]);
      expect(ledger.cleanup, "Private teardown errors").toEqual([]);
    }
  },
});

export { expect };

export async function openRepairWorkspace(page: Page, repair: RepairDaemon) {
  await page.goto(buildHostWorkspaceRoute(repair.serverId, repair.workspaceId));
  await expect(page.getByTestId("swarm-sidebar-mode").filter({ visible: true })).toBeVisible();
}

export async function openRepairBoard(page: Page, repair: RepairDaemon) {
  await openRepairWorkspace(page, repair);
  await page
    .getByTestId("swarm-sidebar-mode")
    .filter({ visible: true })
    .getByText("Swarm", { exact: true })
    .click();
  const planner = repair.agents.find((agent) => agent.qualifiedName === "qa-planner")!;
  await page
    .getByTestId(`swarm-planner-tasks-${planner.paseoAgentId}`)
    .filter({ visible: true })
    .click();
  await expect(page.getByTestId("swarm-task-surface").filter({ visible: true })).toHaveCount(1);
}

export async function chooseRepairScope(page: Page, label: string) {
  const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
  await surface.getByRole("button", { name: "Scope", exact: true }).click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(surface.getByRole("button", { name: "Scope", exact: true })).toContainText(label);
}
