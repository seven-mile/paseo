import type { Page } from "@playwright/test";
import type { AgentRecord } from "../../../../plugins/paseo-swarm/shared/models";
import {
  createTaskRpc,
  pwaSourceReadRpc,
  registerAgentRpc,
  resolveAgentConfigRpc,
} from "../../../../plugins/paseo-swarm/shared/swarm";
import { swarmTest, type SwarmFixture } from "../support/helpers/swarm-test-daemon";
import { openProjects, openProjectSettings } from "../support/helpers/project-settings";
import { existsSync } from "node:fs";
import path from "node:path";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  archiveLocalWorkspaceFromDaemon,
  assertNewWorkspaceSidebarAndHeader,
  closeBranchPicker,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  delayBrowserAgentCreatedStatus,
  expectComposerGithubAttachmentPill,
  expectNewWorkspaceProjectSelected,
  expectPickerClosed,
  expectPickerOpen,
  expectPickerSelected,
  expectStartingRefPickerTriggerPr,
  fillNewWorkspaceDraft,
  loadSessionMessageReaders,
  openGlobalNewWorkspaceComposer,
  openBranchPicker,
  openNewWorkspaceComposer,
  openProjectViaDaemon,
  openStartingRefPicker,
  pasteGithubPrUrl,
  captureStartingRefPicker,
  expectStartingRefRows,
  startingRefRow,
  submitNewWorkspaceEmpty,
  searchAndSelectBranchInPicker,
  selectBranchInPicker,
  selectGitHubPrInPicker,
  selectPickerOptionByKeyboard,
  selectWorkspaceIsolation,
  submitNewWorkspacePrompt,
} from "../support/helpers/new-workspace";
import {
  commitLocalOnly,
  createTempGitRepo,
  readRepoRef,
  readWorktreeBaseMetadata,
  readWorktreeBranchInfo,
  trackForkUpstream,
} from "../support/helpers/workspace";
import {
  createLocalGithubPrFixture,
  cloneGithubRepoDefaultBranchOnly,
  createTempGithubRepo,
  hasGithubAuth,
  type LocalGhPrFixture,
} from "../support/helpers/github-fixtures";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarStatusGrouping } from "../support/helpers/sidebar";
import { getE2EDaemonPort } from "../support/helpers/daemon-port";
import { chooseAddProjectMethod, expectAddProjectPage } from "../support/helpers/add-project-flow";
import { seedSavedSettingsHosts } from "../support/helpers/settings";
import {
  expectSidebarWorkspaceSelected,
  expectWorkspaceHeader,
  switchWorkspaceViaSidebar,
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";
import { dropFileOnComposer, expectAttachmentPill } from "../support/helpers/composer";

const BACKGROUND_RESOLUTION_FILE = {
  name: "background-context.json",
  mimeType: "application/json",
  buffer: Buffer.from(JSON.stringify({ composer: "background-resolution" })),
};

async function configureSwarmSource(page: Page, swarm: SwarmFixture) {
  await openProjects(page);
  await openProjectSettings(page, swarm.projectName);
  await page.getByTestId("project-pwa-edit").click();
  const sheet = page.getByTestId("project-pwa-sheet");
  await page.getByTestId("project-pwa-directory").fill(swarm.contentRoot);
  await page.getByTestId("project-pwa-save").click();
  await expect(page.getByTestId("project-pwa-saved")).toBeVisible();
  await sheet
    .getByRole("button", { name: "Close", exact: true })
    .filter({ hasText: /^Close$/ })
    .click();
}

async function openSwarmWorkspace(page: Page, swarm: SwarmFixture) {
  await page.goto(buildHostWorkspaceRoute(swarm.serverId, swarm.workspaceId));
  await page
    .getByTestId("swarm-sidebar-mode")
    .filter({ visible: true })
    .getByText("Swarm", { exact: true })
    .click();
}

async function waitForSwarmAgent(swarm: SwarmFixture, name: string) {
  await expect
    .poll(
      async () =>
        (await swarm.board()).agents.find((agent) => agent.qualifiedName === name)?.workspaceId,
    )
    .toBeTruthy();
  const agent = (await swarm.board()).agents.find((entry) => entry.qualifiedName === name);
  if (!agent?.workspaceId) throw new Error(`Swarm registration missing for ${name}`);
  return { ...agent, workspaceId: agent.workspaceId };
}

async function openSwarmPlannerForm(page: Page, swarm: SwarmFixture, directory: "alpha" | "beta") {
  const title = directory === "alpha" ? "Alpha" : "Beta";
  const name = `qa-${directory}`;
  const brief = `Exercise the ${title} team.`;
  await openSwarmWorkspace(page, swarm);
  await page
    .getByRole("button", { name: "Add planner", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByTestId("new-workspace-project-picker-trigger")).toContainText(
    swarm.projectName,
  );
  await page.getByTestId("swarm-pwa-directory").click();
  await page.getByRole("button", { name: `${title} · ${directory}`, exact: true }).click();
  await page.getByRole("textbox", { name: "Agent name", exact: true }).fill(name);
  await page.getByTestId("swarm-role").click();
  await page.getByRole("button", { name: `${title} planner`, exact: true }).click();
  await expect(page.getByTestId("swarm-parent")).toHaveCount(0);
  return { name, brief, title };
}

async function createSwarmPlanner(page: Page, swarm: SwarmFixture, directory: "alpha" | "beta") {
  const { name, brief, title } = await openSwarmPlannerForm(page, swarm, directory);
  const resolved = resolveAgentConfigRpc.output.parse(
    await swarm.client.invokePluginRpc("paseo-swarm", resolveAgentConfigRpc.name, {
      projectId: swarm.projectId,
      pwaDirectory: directory,
      name,
      roleClass: "planner",
      role: "planner",
      brief,
    }),
  );
  // The independent read-only call must not reserve a Swarm name or identity.
  expect(
    (await swarm.board()).agents.find((agent) => agent.qualifiedName === name),
  ).toBeUndefined();
  await selectWorkspaceIsolation(page, "worktree");
  await submitNewWorkspacePrompt(page, brief);
  const agent = await waitForSwarmAgent(swarm, name);
  await expect(page).toHaveURL(
    (url) => url.pathname === buildHostWorkspaceRoute(swarm.serverId, agent.workspaceId),
  );
  await expect(
    page.getByTestId(`swarm-planner-row-${agent.paseoAgentId}`).filter({ visible: true }),
  ).toBeVisible();
  expect(agent.pwaBinding).toEqual(resolved.pwaBinding);
  expect(agent.pwaBinding?.directory).toBe(path.join(swarm.contentRoot, directory));
  expect(resolved.parentAgentId).toBeNull();
  expect(swarm.nativePrompt(agent.paseoAgentId)).toBe(resolved.systemPrompt);
  expect(resolved.systemPrompt).toContain(`${title} planner guidance.`);
  expect(resolved.systemPrompt).toContain(`${title} working agreement.`);
  return agent;
}

async function createSwarmChild(page: Page, swarm: SwarmFixture, parent: AgentRecord) {
  const name = "qa-child";
  const brief = "Exercise inherited Beta supervision.";
  await openSwarmWorkspace(page, swarm);
  await page
    .getByTestId(`swarm-planner-row-${parent.paseoAgentId}`)
    .filter({ visible: true })
    .hover();
  await page
    .getByRole("button", { name: `Add supervisor under ${parent.name}`, exact: true })
    .filter({ visible: true })
    .click();
  await expect(page.getByTestId("swarm-parent")).toContainText(parent.name);
  await expect(
    page.getByText(`Inherited PWA · ${path.join(swarm.contentRoot, "beta")}`, { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("swarm-pwa-directory")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Agent name", exact: true }).fill(name);
  await page.getByTestId("swarm-role").click();
  await page.getByRole("button", { name: "Shared supervisor", exact: true }).click();
  const resolved = resolveAgentConfigRpc.output.parse(
    await swarm.client.invokePluginRpc("paseo-swarm", resolveAgentConfigRpc.name, {
      projectId: swarm.projectId,
      name,
      roleClass: "supervisor",
      role: "supervisor",
      reportsTo: parent.qualifiedName,
      brief,
    }),
  );
  await selectWorkspaceIsolation(page, "worktree");
  await submitNewWorkspacePrompt(page, brief);
  const child = await waitForSwarmAgent(swarm, `${parent.qualifiedName}.${name}`);
  await expect(page).toHaveURL(
    (url) => url.pathname === buildHostWorkspaceRoute(swarm.serverId, child.workspaceId),
  );
  expect(child.pwaBinding).toEqual(parent.pwaBinding);
  expect(child.reportsTo).toBe(parent.qualifiedName);
  expect(child.workspaceId).not.toBe(parent.workspaceId);
  expect(resolved.parentAgentId).toBe(parent.paseoAgentId);
  expect(swarm.nativePrompt(child.paseoAgentId)).toBe(resolved.systemPrompt);
  expect(resolved.systemPrompt).toContain("Shared supervisor guidance.");
  expect(resolved.systemPrompt).toContain("Beta working agreement.");
  expect(resolved.systemPrompt).not.toContain("Alpha working agreement.");
  const native = await swarm.client.fetchAgent(child.paseoAgentId);
  expect(native?.agent.labels["paseo.parent-agent-id"]).toBe(parent.paseoAgentId);
  return child;
}

async function expectSwarmTeam(
  page: Page,
  swarm: SwarmFixture,
  planner: AgentRecord,
  status: string,
  otherStatus: string,
  taskId: string,
  otherTaskId: string,
) {
  await openSwarmWorkspace(page, swarm);
  await page
    .getByTestId(`swarm-planner-row-${planner.paseoAgentId}`)
    .filter({ visible: true })
    .hover();
  await page
    .getByTestId(`swarm-planner-tasks-${planner.paseoAgentId}`)
    .filter({ visible: true })
    .click();
  const board = page.getByTestId("swarm-task-surface").filter({ visible: true });
  await expect(board.getByTestId(`swarm-column-${status}`)).toBeVisible();
  await expect(board.getByTestId(`swarm-column-${otherStatus}`)).toHaveCount(0);
  await expect(board.getByTestId(`swarm-task-${taskId}`).filter({ visible: true })).toBeVisible();
  await expect(board.getByTestId(`swarm-task-${otherTaskId}`)).toHaveCount(0);
}

swarmTest(
  "Multiple PWA: second-source planner, inherited child and isolated team workflows",
  async ({ page, swarm }, testInfo) => {
    swarmTest.setTimeout(210_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await configureSwarmSource(page, swarm);
    const source = pwaSourceReadRpc.output.parse(
      await swarm.client.invokePluginRpc("paseo-swarm", pwaSourceReadRpc.name, {
        projectId: swarm.projectId,
      }),
    );
    expect(source.path).toBe(swarm.contentRoot);
    expect(source.entries?.map((entry) => entry.directory).sort()).toEqual(["alpha", "beta"]);
    const alpha = await createSwarmPlanner(page, swarm, "alpha");
    const beta = await createSwarmPlanner(page, swarm, "beta");
    const child = await createSwarmChild(page, swarm, beta);
    await swarm.client.invokePluginRpc("paseo-swarm", createTaskRpc.name, {
      id: "alpha-task",
      title: "Alpha task",
      brief: "Alpha only",
      status: "survey",
      managerName: alpha.qualifiedName,
      createdBy: alpha.qualifiedName,
    });
    await swarm.client.invokePluginRpc("paseo-swarm", createTaskRpc.name, {
      id: "beta-task",
      title: "Beta child task",
      brief: "Beta only",
      status: "queued",
      managerName: child.qualifiedName,
      createdBy: beta.qualifiedName,
    });
    await expectSwarmTeam(page, swarm, beta, "queued", "survey", "beta-task", "alpha-task");
    await page.screenshot({ path: testInfo.outputPath("multiple-pwa-beta-team.png") });
    await expectSwarmTeam(page, swarm, alpha, "survey", "queued", "alpha-task", "beta-task");
    await page.screenshot({ path: testInfo.outputPath("multiple-pwa-alpha-team.png") });
  },
);

async function rejectFirstSwarmRegistration(page: Page, port: number) {
  const frames = await loadSessionMessageReaders();
  const observed = {
    configReads: 0,
    nativeCreates: 0,
    sentMessages: 0,
    reconnectReady: false,
    registrations: [] as ReturnType<typeof registerAgentRpc.input.parse>[],
  };
  await page.routeWebSocket(
    (url) =>
      url.protocol === "ws:" &&
      !url.username &&
      !url.password &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      Number(url.port) === port,
    (socket) => {
      const afterFirstRegistration = observed.registrations.length > 0;
      const server = socket.connectToServer();
      socket.onMessage((message) => {
        const frame = frames.client(message);
        if (afterFirstRegistration && frame?.type === "fetch_agents_request")
          observed.reconnectReady = true;
        if (frame?.type === "send_agent_message_request") observed.sentMessages += 1;
        if (
          frame?.type === "workspace.create.request" ||
          frame?.type === "agent.create.request" ||
          frame?.type === "create_agent_request"
        )
          observed.nativeCreates += 1;
        if (frame?.type === "plugin.rpc.invoke.request" && frame.pluginId === "paseo-swarm") {
          if (frame.method === "swarm.agent.config.read") observed.configReads += 1;
          if (frame.method === registerAgentRpc.name) {
            observed.registrations.push(registerAgentRpc.input.parse(frame.input));
            if (observed.registrations.length === 1) {
              // A real transport failure before dispatch. No synthetic RPC reply.
              void Promise.all([
                socket.close({ code: 4000, reason: "Test: first registration disconnected" }),
                server.close(),
              ]);
              return;
            }
          }
        }
        server.send(message);
      });
    },
  );
  return observed;
}

swarmTest(
  "Multiple PWA: failed registration retries the same native agent without losing an edited brief",
  async ({ page, swarm }, testInfo) => {
    swarmTest.setTimeout(210_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await configureSwarmSource(page, swarm);
    const before = (await swarm.client.fetchAgents({ filter: { includeArchived: true } })).entries
      .length;
    const observed = await rejectFirstSwarmRegistration(page, swarm.port);
    const { name, brief } = await openSwarmPlannerForm(page, swarm, "beta");
    await selectWorkspaceIsolation(page, "worktree");
    await submitNewWorkspacePrompt(page, brief);
    await expect.poll(() => observed.registrations.length).toBe(1);
    const original = observed.registrations[0];
    if (!original) throw new Error("No real registration request observed");
    const draft = page.getByTestId("workspace-pane-main").filter({ visible: true });
    await expect(
      draft.getByText(
        `Native agent ${original.paseoAgentId} was created and may already be running, but Swarm registration failed:`,
        { exact: false },
      ),
    ).toBeVisible();
    expect((await swarm.board()).agents).toHaveLength(0);
    const native = await swarm.client.fetchAgent(original.paseoAgentId);
    expect(native?.agent.workspaceId).toBe(original.workspaceId);
    expect(
      (await swarm.client.fetchAgents({ filter: { includeArchived: true } })).entries,
    ).toHaveLength(before + 1);
    const originalPrompt = swarm.nativePrompt(original.paseoAgentId);
    expect(originalPrompt).toContain(brief);
    const counts = { configReads: observed.configReads, nativeCreates: observed.nativeCreates };
    expect(counts).toEqual({ configReads: 1, nativeCreates: 1 });
    const input = draft.getByRole("textbox", { name: "Message agent...", exact: true });
    await expect(input).toHaveValue(brief);
    const edited = "Edited brief B must remain in the composer.";
    await input.fill(edited);
    await draft.getByRole("button", { name: "Send message", exact: true }).click();
    await expect(
      draft
        .getByText(
          `Native agent ${original.paseoAgentId} already exists with the original message. Your edited brief or attachments have not been sent and are preserved. Restore the original message to retry registration; another agent will not be created.`,
          { exact: true },
        )
        .and(draft.getByRole("alert")),
    ).toBeVisible();
    await expect(input).toHaveValue(edited);
    await page.screenshot({ path: testInfo.outputPath("multiple-pwa-edited-brief-preserved.png") });
    expect(observed.registrations).toHaveLength(1);
    expect(observed.sentMessages).toBe(0);
    expect(swarm.nativePrompt(original.paseoAgentId)).toBe(originalPrompt);
    expect({ configReads: observed.configReads, nativeCreates: observed.nativeCreates }).toEqual(
      counts,
    );
    expect(
      (await swarm.client.fetchAgents({ filter: { includeArchived: true } })).entries,
    ).toHaveLength(before + 1);
    await expect.poll(() => observed.reconnectReady).toBe(true);
    await input.fill(brief);
    await draft.getByRole("button", { name: "Send message", exact: true }).click();
    const registered = await waitForSwarmAgent(swarm, name);
    await expect(page).toHaveURL(
      (url) => url.pathname === buildHostWorkspaceRoute(swarm.serverId, registered.workspaceId),
    );
    expect(registered.paseoAgentId).toBe(original.paseoAgentId);
    expect(registered.workspaceId).toBe(original.workspaceId);
    expect(observed.registrations).toEqual([original, original]);
    expect({ configReads: observed.configReads, nativeCreates: observed.nativeCreates }).toEqual(
      counts,
    );
    expect(
      (await swarm.client.fetchAgents({ filter: { includeArchived: true } })).entries,
    ).toHaveLength(before + 1);
    expect(observed.sentMessages).toBe(0);
    expect(swarm.nativePrompt(original.paseoAgentId)).toBe(originalPrompt);
    await expect(
      page.getByTestId(`swarm-planner-row-${original.paseoAgentId}`).filter({ visible: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("multiple-pwa-registration-recovered.png") });
  },
);

interface WorkspaceStatusGroupEvent {
  rowTestId: string;
  bucket: string;
  indicatorTestId: string | null;
  label: string;
  at: number;
}

async function switchSidebarToStatusGrouping(page: import("@playwright/test").Page) {
  await selectSidebarStatusGrouping(page);
  await expect(page.getByTestId("sidebar-status-group-done")).toBeVisible({ timeout: 30_000 });
}

async function startTrackingSidebarStatusGroups(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    interface StatusGroupEvent {
      rowTestId: string;
      bucket: string;
      indicatorTestId: string | null;
      label: string;
      at: number;
    }
    const win = window as typeof window & {
      __workspaceStatusGroupEvents?: StatusGroupEvent[];
      __workspaceStatusGroupObserver?: MutationObserver;
    };
    win.__workspaceStatusGroupEvents = [];
    win.__workspaceStatusGroupObserver?.disconnect();

    const capture = () => {
      const events = win.__workspaceStatusGroupEvents;
      if (!events) return;
      const groups = document.querySelectorAll<HTMLElement>(
        '[data-testid^="sidebar-status-group-"]',
      );
      for (const group of groups) {
        const groupTestId = group.getAttribute("data-testid") ?? "";
        const bucket = groupTestId.replace("sidebar-status-group-", "");
        const label = group.textContent ?? "";
        const block = group.parentElement?.parentElement;
        if (!block) continue;
        const rows = block.querySelectorAll<HTMLElement>('[data-testid^="sidebar-workspace-row-"]');
        for (const row of rows) {
          const rowTestId = row.getAttribute("data-testid");
          if (!rowTestId) continue;
          const indicatorTestId =
            row
              .querySelector<HTMLElement>('[data-testid^="workspace-status-indicator-"]')
              ?.getAttribute("data-testid") ?? null;
          const last = events.at(-1);
          if (
            last?.rowTestId === rowTestId &&
            last.bucket === bucket &&
            last.indicatorTestId === indicatorTestId
          ) {
            continue;
          }
          events.push({ rowTestId, bucket, indicatorTestId, label, at: performance.now() });
        }
      }
    };

    capture();
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-testid"],
    });
    win.__workspaceStatusGroupObserver = observer;
  });
}

async function getTrackedSidebarStatusGroups(
  page: import("@playwright/test").Page,
): Promise<WorkspaceStatusGroupEvent[]> {
  return page.evaluate(() => {
    const win = window as typeof window & {
      __workspaceStatusGroupEvents?: WorkspaceStatusGroupEvent[];
    };
    return win.__workspaceStatusGroupEvents ?? [];
  });
}

async function waitForWorkspaceStatusGroupEvent(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
  bucket: string;
}) {
  await input.page.waitForFunction(
    ({ expectedRowTestId, expectedBucket }) => {
      const win = window as typeof window & {
        __workspaceStatusGroupEvents?: WorkspaceStatusGroupEvent[];
      };
      for (const event of win.__workspaceStatusGroupEvents ?? []) {
        if (event.rowTestId === expectedRowTestId && event.bucket === expectedBucket) {
          return true;
        }
      }
      return false;
    },
    { expectedRowTestId: input.rowTestId, expectedBucket: input.bucket },
    { timeout: 30_000 },
  );
}

async function expectWorkspaceStatusGroupEvents(input: {
  page: import("@playwright/test").Page;
  rowTestId: string;
  includes: string;
  excludes: string;
  excludesIndicator?: string;
}) {
  await waitForWorkspaceStatusGroupEvent({
    page: input.page,
    rowTestId: input.rowTestId,
    bucket: input.includes,
  });
  const createdWorkspaceEvents = (await getTrackedSidebarStatusGroups(input.page)).filter(
    (event) => event.rowTestId === input.rowTestId,
  );
  expect(createdWorkspaceEvents.map((event) => event.bucket)).toContain(input.includes);
  expect(createdWorkspaceEvents.filter((event) => event.bucket === input.excludes)).toEqual([]);
  if (input.excludesIndicator) {
    expect(
      createdWorkspaceEvents.filter((event) => event.indicatorTestId === input.excludesIndicator),
    ).toEqual([]);
  }
}

async function submitNewWorkspaceWithoutPrompt(page: import("@playwright/test").Page) {
  const createButton = page
    .getByTestId("message-input-root")
    .getByRole("button", { name: "Create" });
  await expect(createButton).toBeVisible({ timeout: 30_000 });
  await createButton.click();
}

test.describe("New workspace flow", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  const localWorkspaceIds = new Set<string>();
  const localProjectIds = new Set<string>();
  const createdWorktreeDirectories = new Set<string>();
  const localGithubFixtures = new Set<LocalGhPrFixture>();

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    if (client) {
      for (const workspaceDirectory of createdWorktreeDirectories) {
        await archiveWorkspaceFromDaemon(client, workspaceDirectory).catch(() => undefined);
      }
      for (const workspaceId of localWorkspaceIds) {
        await archiveLocalWorkspaceFromDaemon(client, workspaceId).catch(() => undefined);
      }
      for (const projectId of localProjectIds) {
        await client.removeProject(projectId).catch(() => undefined);
      }
    }
    createdWorktreeDirectories.clear();
    localWorkspaceIds.clear();
    localProjectIds.clear();
    await client?.close().catch(() => undefined);
  });

  test.afterAll(async () => {
    for (const fixture of localGithubFixtures) {
      await fixture.cleanup();
    }
    localGithubFixtures.clear();
  });

  test("adds a project from the selected empty host", async ({ page }) => {
    const repo = await createTempGitRepo("new-workspace-project-picker-");
    const primaryServerId = getServerId();
    const emptyServerId = "empty-new-workspace-host";

    try {
      const openedProject = await openProjectViaDaemon(client, repo.path);
      localWorkspaceIds.add(openedProject.workspaceId);
      await seedSavedSettingsHosts(page, [
        {
          serverId: primaryServerId,
          label: "Primary host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: emptyServerId,
          label: "Empty host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      const projectTrigger = page.getByTestId("new-workspace-project-picker-trigger");
      await projectTrigger.click();
      await page.getByPlaceholder("Search projects").fill("no matching project");
      await expect(page.getByTestId("new-workspace-project-picker-add-project")).toBeVisible();
      await page.keyboard.press("Escape");

      await page.getByTestId("host-picker-trigger").click();
      await page.getByTestId(`new-workspace-host-picker-option-${emptyServerId}`).click();
      await expect(projectTrigger).toContainText("Choose project");
      await projectTrigger.click();

      const addProject = page.getByTestId("new-workspace-project-picker-add-project");
      await expect(addProject).toContainText("Add project");
      await expect(addProject).toContainText(/(?:⌘|Ctrl\+)O/);
      await addProject.click();

      await expectAddProjectPage(page, "method");
      await chooseAddProjectMethod(page, "directory-search");
    } finally {
      await repo.cleanup();
    }
  });

  test("sidebar workspace navigation updates URL and header", async ({ page }) => {
    const serverId = getServerId();

    const firstRepo = await createTempGitRepo("workspace-nav-a-");
    const secondRepo = await createTempGitRepo("workspace-nav-b-");

    try {
      const firstWorkspace = await openProjectViaDaemon(client, firstRepo.path);
      const secondWorkspace = await openProjectViaDaemon(client, secondRepo.path);
      localWorkspaceIds.add(firstWorkspace.workspaceId);
      localWorkspaceIds.add(secondWorkspace.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId,
        workspaceId: secondWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: secondWorkspace.workspaceName,
        subtitle: secondWorkspace.projectDisplayName,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: firstWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: firstWorkspace.workspaceName,
        subtitle: firstWorkspace.projectDisplayName,
      });
    } finally {
      await secondRepo.cleanup();
      await firstRepo.cleanup();
    }
  });

  test("same-project workspaces switch content without requiring refresh", async ({ page }) => {
    const serverId = getServerId();

    const repo = await createTempGitRepo("workspace-nav-same-project-");

    try {
      const rootWorkspace = await openProjectViaDaemon(client, repo.path);
      const worktreeWorkspace = await createWorktreeViaDaemon(client, {
        cwd: repo.path,
        slug: `nav-${Date.now()}`,
      });
      localWorkspaceIds.add(rootWorkspace.workspaceId);
      createdWorktreeDirectories.add(worktreeWorkspace.workspaceDirectory);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: worktreeWorkspace.workspaceName,
        subtitle: worktreeWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
        selected: false,
      });

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: rootWorkspace.workspaceName,
        subtitle: rootWorkspace.projectDisplayName,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: rootWorkspace.workspaceId,
      });
      await expectSidebarWorkspaceSelected({
        page,
        serverId,
        workspaceId: worktreeWorkspace.workspaceId,
        selected: false,
      });
    } finally {
      await repo.cleanup();
    }
  });

  test("global new workspace uses the last active project and creates one agent tab", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(createdWorkspace.workspaceId).not.toBe(openedProject.workspaceId);
      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const createdWorkspaceRow = page.getByTestId(
        `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`,
      );
      await expect(createdWorkspaceRow).toBeVisible({ timeout: 30_000 });

      await expectWorkspaceHeader(page, {
        title: createdWorkspace.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const agentTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]');
      await expect(agentTabs).toHaveCount(1, { timeout: 30_000 });

      // Workspace setup may auto-open a setup tab that steals focus,
      // hiding the agent panel (display:none removes it from the
      // accessibility tree). Click the agent tab to ensure it's active.
      await agentTabs.first().click();

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("redirects to the optimistic draft tab before agent creation resolves", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-optimistic-");
    const agentCreatedDelay = await delayBrowserAgentCreatedStatus(page);

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeVisible({ timeout: 30_000 });
      await composer.fill("Hello from e2e");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      await agentCreatedDelay.waitForCreateRequest();
      await agentCreatedDelay.waitForDelayedCreatedStatus();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      await expect(page).toHaveURL(
        buildHostWorkspaceRoute(serverId, createdWorkspace.workspaceId),
        {
          timeout: 30_000,
        },
      );

      const activeWorkspaceDeckEntry = page
        .getByTestId(`workspace-deck-entry-${serverId}:${createdWorkspace.workspaceId}`)
        .filter({ visible: true });
      await expect(activeWorkspaceDeckEntry).toBeVisible({ timeout: 30_000 });

      const draftTabs = activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-draft_"]');
      await expect(draftTabs).toHaveCount(1, { timeout: 30_000 });
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(0);

      agentCreatedDelay.release();
      await expect(
        activeWorkspaceDeckEntry.locator('[data-testid^="workspace-tab-agent_"]'),
      ).toHaveCount(1, { timeout: 30_000 });
    } finally {
      agentCreatedDelay.release();
      await tempRepo.cleanup();
    }
  });

  test("new workspace with initial agent never appears in the Done status group", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-optimistic-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await switchSidebarToStatusGrouping(page);
      await startTrackingSidebarStatusGroups(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspacePrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
        assertSidebarRow: false,
        assertHeader: false,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "running",
        excludes: "done",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("new workspace without an initial agent appears in the Done status group", async ({
    page,
  }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-status-empty-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await switchSidebarToStatusGrouping(page);
      await startTrackingSidebarStatusGroups(page);

      await openGlobalNewWorkspaceComposer(page);
      await expectNewWorkspaceProjectSelected(page, openedProject.projectDisplayName);
      await submitNewWorkspaceWithoutPrompt(page);

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      const rowTestId = `sidebar-workspace-row-${serverId}:${createdWorkspace.workspaceId}`;
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "done",
        excludes: "running",
        excludesIndicator: "workspace-status-indicator-loading",
      });
      await expectWorkspaceStatusGroupEvents({
        page,
        rowTestId,
        includes: "done",
        excludes: "running",
        excludesIndicator: "workspace-status-indicator-running",
      });
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected branch becomes the base of a new workspace worktree", async ({ page }) => {
    const serverId = getServerId();

    const tempRepo = await createTempGitRepo("new-workspace-ref-", {
      branches: ["main", "dev"],
    });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);

      await switchWorkspaceViaSidebar({
        page,
        serverId,
        workspaceId: openedProject.workspaceId,
      });
      await expectWorkspaceHeader(page, {
        title: openedProject.workspaceName,
        subtitle: openedProject.projectDisplayName,
      });

      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectBranchInPicker(page, "dev");

      const createButton = page
        .getByTestId("message-input-root")
        .getByRole("button", { name: "Create" });
      await expect(createButton).toBeVisible({ timeout: 30_000 });
      await createButton.click();

      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId,
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);

      expect(existsSync(createdWorkspace.workspaceDirectory)).toBe(true);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: createdWorkspace.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(path.basename(createdWorkspace.workspaceDirectory));
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.main)).toBe(true);
      expect(branchInfo.hasAncestor(tempRepo.branchHeads.dev)).toBe(true);
    } finally {
      await tempRepo.cleanup();
    }
  });

  // The starting ref the daemon actually cuts from is the thing that broke: the picker said
  // one ref and the worktree was created from another. Every assertion here reads the
  // created worktree's commits or its recorded base, never the trigger text alone.
  test.describe("default starting ref", () => {
    async function openWorktreeComposerForRepo(
      page: import("@playwright/test").Page,
      repoPath: string,
    ) {
      const openedProject = await openProjectViaDaemon(client, repoPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      return openedProject;
    }

    async function createWorktreeAndRead(
      page: import("@playwright/test").Page,
      openedProject: Awaited<ReturnType<typeof openProjectViaDaemon>>,
    ) {
      await submitNewWorkspaceEmpty(page);
      const createdWorkspace = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(createdWorkspace.workspaceDirectory);
      return {
        ...createdWorkspace,
        branchInfo: await readWorktreeBranchInfo({
          worktreePath: createdWorkspace.workspaceDirectory,
        }),
      };
    }

    test("branches off the upstream when the local branch is ahead and the picker is untouched", async ({
      page,
    }) => {
      const tempRepo = await createTempGitRepo("ref-default-ahead-", { withRemote: true });

      try {
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);
        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(originHead)).toBe(true);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(false);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off the local ref when the local row is chosen explicitly", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-local-pick-", { withRemote: true });

      try {
        commitLocalOnly(tempRepo.path, "one");
        const localHead = commitLocalOnly(tempRepo.path, "two");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        await expectStartingRefRows(page, [
          "main, origin branch",
          "main, local branch, 2 commits ahead of origin main",
        ]);
        const screenshotPath = testInfo.outputPath("ref-picker-local-ahead.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: local ahead of upstream", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await startingRefRow(page, "main, local branch, 2 commits ahead of origin main").click();
        await expectPickerSelected(page, "main (local)");

        const created = await createWorktreeAndRead(page, openedProject);
        expect(created.branchInfo.hasAncestor(localHead)).toBe(true);
      } finally {
        await tempRepo.cleanup();
      }
    });

    test("branches off a fork's upstream remote and records the branch name", async ({
      page,
    }, testInfo) => {
      const tempRepo = await createTempGitRepo("ref-default-fork-", { withRemote: true });

      try {
        const upstreamHead = await trackForkUpstream(tempRepo.path);
        const originHead = readRepoRef(tempRepo.path, "refs/remotes/origin/main");

        const openedProject = await openWorktreeComposerForRepo(page, tempRepo.path);

        await openStartingRefPicker(page);
        // Branch suggestions only know about origin, so the upstream the fork actually
        // tracks gets its own row rather than silently sharing origin's. Two rows reading
        // "main" is the ambiguity this whole change exists to remove.
        await expectStartingRefRows(page, [
          "main (upstream), upstream branch",
          "main, origin branch",
        ]);
        await expectPickerSelected(page, "main (upstream)");
        const screenshotPath = testInfo.outputPath("ref-picker-fork.png");
        await captureStartingRefPicker(page, screenshotPath);
        await testInfo.attach("Ref picker: fork tracking upstream/main", {
          path: screenshotPath,
          contentType: "image/png",
        });
        await closeBranchPicker(page);

        const created = await createWorktreeAndRead(page, openedProject);

        expect(created.branchInfo.hasAncestor(upstreamHead)).toBe(true);
        expect(upstreamHead).not.toBe(originHead);
        // The name is what the UI shows; the ref is what resolves back to this commit.
        expect(await readWorktreeBaseMetadata(created.workspaceDirectory)).toEqual({
          baseRefName: "main",
          baseRef: "refs/remotes/upstream/main",
        });
      } finally {
        await tempRepo.cleanup();
      }
    });
  });

  test("branch picker opens via keyboard and selects the filtered option on Enter", async ({
    page,
  }) => {
    const tempRepo = await createTempGitRepo("picker-keyboard-", { branches: ["main", "dev"] });

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");

      await openBranchPicker(page);
      await expectPickerOpen(page);
      await selectPickerOptionByKeyboard(page, "dev");
      await expectPickerSelected(page, "dev");
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("branch picker closes on Escape without selecting an option", async ({ page }) => {
    const tempRepo = await createTempGitRepo("picker-escape-");

    try {
      const openedProject = await openProjectViaDaemon(client, tempRepo.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");

      await openBranchPicker(page);
      await expectPickerOpen(page);
      await closeBranchPicker(page);
      await expectPickerClosed(page);
    } finally {
      await tempRepo.cleanup();
    }
  });

  test("selected GitHub PR shows PR context in the trigger and composer", async ({ page }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-ref",
      prs: [{ title: "Review selected start ref", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;

    try {
      const openedProject = await openProjectViaDaemon(client, pr.localPath);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);

      await expectStartingRefPickerTriggerPr(page, {
        number: pr.number,
        title: pr.title,
        headRef: pr.branch,
      });
      await expectComposerGithubAttachmentPill(page, {
        number: pr.number,
        title: pr.title,
      });
    } finally {
      await ghRepo.cleanup();
    }
  });

  test("pasted GitHub PR replaces a selected branch and creates its worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await openStartingRefPicker(page);
    await selectBranchInPicker(page, "main");

    await pasteGithubPrUrl(page, context, pr.url);

    const createButton = page.getByTestId("workspace-create-submit");
    await expect(createButton).toBeDisabled();
    await expect(createButton.getByRole("progressbar")).toHaveCount(0);

    await dropFileOnComposer(page, BACKGROUND_RESOLUTION_FILE);
    await expectAttachmentPill(page, "composer-file-attachment-pill");

    await expectComposerGithubAttachmentPill(page, {
      number: pr.number,
      title: pr.title,
    });
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    const branchInfo = await readWorktreeBranchInfo({
      worktreePath: worktree.workspaceDirectory,
    });
    expect(branchInfo.currentBranch).toBe(pr.branch);
    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
  });

  test("branches remain searchable after a pasted PR and determine the created worktree", async ({
    page,
    context,
  }) => {
    const fixture = await createLocalGithubPrFixture();
    localGithubFixtures.add(fixture);
    const { pr, mainCheckout } = fixture;

    const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
    localWorkspaceIds.add(openedProject.workspaceId);
    localProjectIds.add(openedProject.projectId);

    await gotoAppShell(page);
    await waitForSidebarHydration(page);
    await openNewWorkspaceComposer(page, {
      projectKey: openedProject.projectKey,
      projectDisplayName: openedProject.projectDisplayName,
    });
    await selectWorkspaceIsolation(page, "worktree");
    await pasteGithubPrUrl(page, context, pr.url);
    await expectStartingRefPickerTriggerPr(page, {
      number: pr.number,
      title: pr.title,
      headRef: pr.branch,
    });

    await openStartingRefPicker(page);
    await searchAndSelectBranchInPicker(page, "main");
    await expectPickerSelected(page, "main");
    await fillNewWorkspaceDraft(page, `${pr.url}\nKeep this checkout on main`);
    await expectPickerSelected(page, "main");
    await submitNewWorkspaceWithoutPrompt(page);

    const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
      serverId: getServerId(),
      client,
      previousWorkspaceId: openedProject.workspaceId,
      projectDisplayName: openedProject.projectDisplayName,
    });
    createdWorktreeDirectories.add(worktree.workspaceDirectory);

    expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(false);
  });

  test("selected GitHub PR creates the worktree from the PR head even when the head branch is not fetched", async ({
    page,
  }) => {
    test.skip(!hasGithubAuth(), "Requires GitHub authentication (gh auth login)");

    const ghRepo = await createTempGithubRepo({
      category: "new-workspace-pr-worktree",
      prs: [{ title: "Checkout PR worktree", state: "open" }],
    });
    const pr = ghRepo.prs[0]!;
    const mainCheckout = await cloneGithubRepoDefaultBranchOnly(ghRepo);

    try {
      const openedProject = await openProjectViaDaemon(client, mainCheckout.path);
      localWorkspaceIds.add(openedProject.workspaceId);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: openedProject.projectKey,
        projectDisplayName: openedProject.projectDisplayName,
      });
      await selectWorkspaceIsolation(page, "worktree");
      await openStartingRefPicker(page);
      await selectGitHubPrInPicker(page, pr.number);
      await submitNewWorkspaceWithoutPrompt(page);

      const worktree = await assertNewWorkspaceSidebarAndHeader(page, {
        serverId: getServerId(),
        client,
        previousWorkspaceId: openedProject.workspaceId,
        projectDisplayName: openedProject.projectDisplayName,
      });
      createdWorktreeDirectories.add(worktree.workspaceDirectory);

      const branchInfo = await readWorktreeBranchInfo({
        worktreePath: worktree.workspaceDirectory,
      });
      expect(branchInfo.currentBranch).toBe(pr.branch);
      expect(existsSync(path.join(worktree.workspaceDirectory, "pr-1.txt"))).toBe(true);
    } finally {
      await mainCheckout.cleanup();
      await ghRepo.cleanup();
    }
  });
});
