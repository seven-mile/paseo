import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "@playwright/test";
import { expect, test as base, type Page } from "../support/fixtures";
import { connectSeedClient, seedWorkspace } from "../support/helpers/seed-client";
import {
  blockPaseoConfigWrites,
  bumpPaseoConfigOnDisk,
  chooseProjectIconImage,
  clickReloadProjectSettings,
  clickRetryProjectSettingsSave,
  clickSaveProjectSettings,
  commitPaseoConfig,
  corruptPaseoConfig,
  editWorktreeSetup,
  expectEmptyScriptList,
  expectProjectHostContextHidden,
  expectNoEditableTarget,
  expectNoProjectSettingsError,
  expectNoUncommittedSetupWarning,
  expectProjectEditFailed,
  expectProjectEditName,
  expectProjectEditSaved,
  expectProjectEditsSaveDisabled,
  expectProjectSettingsError,
  expectProjectSettingsFormHidden,
  expectProjectSettingsFormVisible,
  expectProjectTitle,
  expectProjectSettingsHistoryRoundTrip,
  expectSaveButtonDisabled,
  expectScriptRowCount,
  expectWriteFailedCalloutActions,
  expectUncommittedSetupWarning,
  fillProjectIconUrl,
  fillProjectName,
  installDaemonConnectionGate,
  installReadTransportFailure,
  navigateToProjectSettings,
  openProjectEditSheet,
  openProjectSettings,
  openProjects,
  removeProjectScript,
  restorePaseoConfig,
  returnToProjectsList,
  saveProjectEdits,
  unblockPaseoConfigWrites,
} from "../support/helpers/project-settings";
import { gotoAppShell } from "../support/helpers/app";
import { openCompactSettings } from "../support/helpers/settings";
import {
  addProjectFlowInput,
  chooseAddProjectMethod,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  buildOpenProjectRoute,
  buildProjectsSettingsRoute,
  buildProjectSettingsRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { getServerId } from "../support/helpers/server-id";
import { expectAppRoute } from "../support/helpers/route-assertions";
import {
  repairTest,
  openRepairBoard,
  chooseRepairScope,
} from "../support/helpers/swarm-test-daemon";

const updatedSetup = ["npm install", "npm run build"];

repairTest(
  "Swarm repair: real Project PWA discovery, default selection and legacy recovery",
  async ({ page, repair }, testInfo) => {
    repairTest.setTimeout(210_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openProjects(page);
    await openProjectSettings(page, repair.projectName);
    const edit = page.getByTestId("project-pwa-edit");
    await expect(edit).toBeEnabled();
    await edit.click();
    const sheet = page.getByTestId("project-pwa-sheet");
    const directory = page.getByTestId("project-pwa-directory");
    const defaults = page.getByTestId("project-pwa-default");
    const save = page.getByTestId("project-pwa-save");
    await expect(directory).toHaveValue(repair.legacyRoot);
    await defaults.click();
    await expect(page.getByRole("button", { name: "Legacy · .", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "No default PWA", exact: true }).click();
    await sheet
      .getByRole("button", { name: "Close", exact: true })
      .filter({ hasText: /^Close$/ })
      .click();
    const before = JSON.parse(await readFile(repair.configPath, "utf8"));
    expect(before.projectDefaults).toBeUndefined();

    await edit.click();
    await directory.fill(repair.collection);
    await directory.press("Tab");
    await expect(defaults).toBeEnabled();
    await defaults.click();
    const alternate = page.getByRole("button", { name: "Alternate · alternate", exact: true });
    await expect(alternate).toBeVisible();
    await expect(page.getByRole("button", { name: "broken · broken", exact: true })).toBeDisabled();
    await alternate.click();
    await expect(sheet).toContainText("Discovery is incomplete.");
    await expect(save).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-pwa-default-discovery.png") });
    await save.click();
    await expect(page.getByTestId("project-pwa-saved")).toBeVisible();
    const selected = JSON.parse(await readFile(repair.configPath, "utf8"));
    expect(selected.projectSources[repair.projectId]).toBe(repair.collection);
    expect(selected.projectDefaults[repair.projectId]).toBe("alternate");
    expect(selected.keepUnknown).toBe("retained");
    await sheet
      .getByRole("button", { name: "Close", exact: true })
      .filter({ hasText: /^Close$/ })
      .click();

    // A collection with no root PWA must not silently rebind the old team to its default.
    await openRepairBoard(page, repair);
    await chooseRepairScope(page, "Planner · qa-planner");
    const recovery = page.getByTestId("swarm-pwa-recovery").filter({ visible: true });
    await expect(recovery).toContainText("Team PWA unavailable");
    await expect(recovery).toContainText(
      "Review this Project's PWA source. Tasks and Activity remain available.",
    );
    const recoverySettings = recovery.getByTestId("swarm-pwa-recovery-settings");
    const detailsToggle = recovery.getByTestId("swarm-pwa-recovery-details-toggle");
    const diagnostic = recovery.getByTestId("swarm-pwa-recovery-diagnostic");
    await expect(recoverySettings).toBeEnabled();
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(diagnostic).toHaveCount(0);
    const unavailableBoard = (await repair.invoke("swarm.board.read", {
      projectId: repair.projectId,
      teamName: "qa-planner",
    })) as { pwaError?: string };
    expect(typeof unavailableBoard.pwaError).toBe("string");
    expect(unavailableBoard.pwaError).not.toBe("");
    const task = page.getByTestId("swarm-task-qa-survey").filter({ visible: true });
    await task.click();
    await expect(page.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "Retained Activity for qa-survey.",
    );
    await page.screenshot({
      path: testInfo.outputPath("swarm-repair-legacy-records-with-pwa-error.png"),
    });

    await page.setViewportSize({ width: 390, height: 844 });
    const closedGeometry = {
      settings: await expectPwaRecoveryControlReachable(recoverySettings),
      details: await expectPwaRecoveryControlReachable(detailsToggle),
    };
    const closedNotice = await recovery.boundingBox();
    expect(closedNotice).not.toBeNull();
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(diagnostic).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("swarm-repair-pwa-recovery-390-collapsed.png"),
    });
    await detailsToggle.click();
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(diagnostic).toBeVisible();
    expect(await diagnostic.textContent()).toBe(unavailableBoard.pwaError);
    const details = recovery.getByTestId("swarm-pwa-recovery-details");
    await expect(details).toBeVisible();
    const detailsBounds = await details.boundingBox();
    expect(detailsBounds).not.toBeNull();
    expect(detailsBounds!.height).toBeGreaterThan(0);
    expect(detailsBounds!.height).toBeLessThan(844 / 3);
    const openGeometry = {
      settings: await expectPwaRecoveryControlReachable(recoverySettings),
      details: await expectPwaRecoveryControlReachable(detailsToggle),
    };
    await expect(page.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "Retained Activity for qa-survey.",
    );
    await page.screenshot({
      path: testInfo.outputPath("swarm-repair-pwa-recovery-390-details.png"),
    });
    await detailsToggle.click();
    await expect(detailsToggle).toHaveAttribute("aria-expanded", "false");
    await expect(diagnostic).toHaveCount(0);
    await expect(details).toHaveCount(0);
    await expect
      .poll(async () => (await recovery.boundingBox())?.height)
      .toBeCloseTo(closedNotice!.height, 0);
    await expect(page.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "Retained Activity for qa-survey.",
    );
    await testInfo.attach("swarm-pwa-recovery-390-geometry", {
      body: JSON.stringify({ closedGeometry, openGeometry, closedNotice, detailsBounds }, null, 2),
      contentType: "application/json",
    });
    await recoverySettings.click();
    await expectAppRoute(page, buildProjectSettingsRoute(repair.serverId, repair.projectId));
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole("textbox", { name: "Worktree setup commands" })).toBeVisible();
    await expectProjectTitle(page, repair.projectName);
    await edit.click();
    await expect(directory).toHaveValue(repair.collection);
    await directory.fill(repair.legacyRoot);
    await directory.press("Tab");
    await expect(save).toBeDisabled();
    await expect(defaults).toBeEnabled();
    await defaults.click();
    await expect(
      page.getByRole("button", { name: "alternate · alternate", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "No default PWA", exact: true }).click();
    await expect(save).toBeEnabled();
    await save.click();
    await expect(page.getByTestId("project-pwa-saved")).toBeVisible();
    await sheet
      .getByRole("button", { name: "Close", exact: true })
      .filter({ hasText: /^Close$/ })
      .click();
    await openRepairBoard(page, repair);
    await chooseRepairScope(page, "Planner · qa-planner");
    await expect(page.getByText(/Team PWA unavailable:/).filter({ visible: true })).toHaveCount(0);
    await expect(page.getByTestId("swarm-pwa-recovery").filter({ visible: true })).toHaveCount(0);
    await expect(page.getByTestId("swarm-task-qa-survey").filter({ visible: true })).toBeVisible();
    const board = (await repair.invoke("swarm.board.read", {})) as { agents: typeof repair.agents };
    expect(
      board.agents.find((agent) => agent.qualifiedName === "qa-planner")?.pwaBinding,
    ).toBeUndefined();
    expect(board.agents.find((agent) => agent.qualifiedName === "qa-other")?.pwaBinding).toEqual(
      repair.agents.find((agent) => agent.qualifiedName === "qa-other")?.pwaBinding,
    );
  },
);

async function expectPwaRecoveryControlReachable(control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const geometry = await control.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    const clipped = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) {
        clipped.left = Math.max(clipped.left, box.left);
        clipped.right = Math.min(clipped.right, box.right);
      }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        clipped.top = Math.max(clipped.top, box.top);
        clipped.bottom = Math.min(clipped.bottom, box.bottom);
      }
    }
    const hit = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    );
    return {
      bounds: bounds.toJSON(),
      clipped,
      centerHitsControl: hit !== null && node.contains(hit),
    };
  });
  expect(geometry.bounds.width).toBeGreaterThan(0);
  expect(geometry.bounds.height).toBeGreaterThan(0);
  expect(geometry.bounds.left).toBeGreaterThanOrEqual(geometry.clipped.left - 1);
  expect(geometry.bounds.right).toBeLessThanOrEqual(geometry.clipped.right + 1);
  expect(geometry.bounds.top).toBeGreaterThanOrEqual(geometry.clipped.top - 1);
  expect(geometry.bounds.bottom).toBeLessThanOrEqual(geometry.clipped.bottom + 1);
  expect(geometry.centerHitsControl).toBe(true);
  await control.click({ trial: true });
  return geometry;
}

const previewFaultTest = repairTest.extend({ repairFault: "settings-preview" as const });

previewFaultTest(
  "Swarm repair fault: stale preview cannot overwrite B and ordinary Retry recovers",
  async ({ page, repair }, testInfo) => {
    previewFaultTest.setTimeout(210_000);
    const fault = repair.fault!;
    expect(fault.evidence.kind).toBe("settings-preview");
    const originalConfig = await readFile(repair.configPath);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openProjects(page);
    await openProjectSettings(page, repair.projectName);
    await page.getByTestId("project-pwa-edit").click();
    const sheet = page.getByTestId("project-pwa-sheet");
    const directory = sheet.getByTestId("project-pwa-directory");
    const defaults = sheet.getByTestId("project-pwa-default");
    const save = sheet.getByTestId("project-pwa-save");
    await expect(directory).toHaveValue(repair.legacyRoot);

    fault.holdPreviewOrder();
    await directory.fill(repair.collection);
    await directory.press("Tab");
    await expect
      .poll(() =>
        fault.evidence.events.some(
          (entry) => entry.action === "reply-held" && entry.label === "preview-A",
        ),
      )
      .toBe(true);
    await expect(save).toBeDisabled();
    await directory.fill(repair.legacyRoot);
    await directory.press("Tab");
    await expect
      .poll(() =>
        fault.evidence.events.some(
          (entry) => entry.action === "reply-held" && entry.label === "preview-B",
        ),
      )
      .toBe(true);
    fault.release("preview-B");
    await expect(defaults).toBeEnabled();
    await defaults.click();
    const choices = page
      .getByTestId("combobox-desktop-container")
      .filter({ visible: true })
      .filter({ has: page.getByRole("button", { name: "Legacy · .", exact: true }) });
    await expect(choices).toHaveCount(1);
    await choices.getByRole("button", { name: "Legacy · .", exact: true }).click();
    await expect(defaults).toContainText(".");
    await expect(save).toBeEnabled();

    await fault.releasePreviewAAndSettle(page);
    await expect(directory).toHaveValue(repair.legacyRoot);
    await expect(defaults).toContainText(".");
    await defaults.click();
    const retainedChoices = page
      .getByTestId("combobox-desktop-container")
      .filter({ visible: true })
      .filter({ has: page.getByRole("button", { name: "Legacy · .", exact: true }) });
    await expect(
      retainedChoices.getByRole("button", { name: "Alternate · alternate", exact: true }),
    ).toHaveCount(0);
    await retainedChoices.getByRole("button", { name: "Legacy · .", exact: true }).click();
    await expect(save).toBeEnabled();
    const a = fault.evidence.rpc.find((entry) => entry.held === "preview-A")!;
    const b = fault.evidence.rpc.find((entry) => entry.held === "preview-B")!;
    expect(a.dispatched && b.dispatched && a.replyForwarded && b.replyForwarded).toBe(true);
    expect(b.deliverySequence!).toBeLessThan(a.deliverySequence!);
    expect(await readFile(repair.configPath)).toEqual(originalConfig);
    await page.screenshot({
      path: testInfo.outputPath("swarm-repair-preview-B-after-stale-A.png"),
    });

    fault.disconnectNextPreview();
    await directory.fill(repair.collection);
    await directory.press("Tab");
    await expect.poll(() => fault.evidence.disconnects.length).toBe(1);
    const failed = fault.evidence.rpc.find(
      (entry) => entry.requestId === fault.evidence.disconnects[0]!.requestId,
    )!;
    expect(failed.method).toBe("swarm.pwa_source.read");
    expect(failed.dispatched).toBe(false);
    expect(failed.responseUtc).toBeUndefined();
    await expect(sheet.getByTestId("project-pwa-default-field")).toContainText(
      /disconnect|closed|connection lost/i,
    );
    await expect(save).toBeDisabled();
    const retry = sheet.getByRole("button", { name: "Retry", exact: true });
    await expect(retry).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-preview-disconnected.png") });
    await expect.poll(() => fault.reconnectObserved()).toBe(true);
    const beforeRetry = fault.evidence.rpc.length;
    await retry.click();
    await expect
      .poll(() =>
        fault.evidence.rpc
          .slice(beforeRetry)
          .some(
            (entry) =>
              entry.method === "swarm.pwa_source.read" &&
              entry.input.path === repair.collection &&
              entry.dispatched &&
              entry.replyForwarded &&
              !entry.error,
          ),
      )
      .toBe(true);
    await expect(defaults).toBeEnabled();
    await defaults.click();
    const retryChoices = page
      .getByTestId("combobox-desktop-container")
      .filter({ visible: true })
      .filter({ has: page.getByRole("button", { name: "Alternate · alternate", exact: true }) });
    await retryChoices.getByRole("button", { name: "Alternate · alternate", exact: true }).click();
    await expect(directory).toHaveValue(repair.collection);
    await expect(defaults).toContainText("alternate");
    await expect(save).toBeEnabled();
    expect(
      fault.evidence.rpc.filter((entry) => entry.method === "swarm.pwa_source.set"),
    ).toHaveLength(0);
    expect(await readFile(repair.configPath)).toEqual(originalConfig);
    expect(fault.evidence.disconnects).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-preview-retry-unsaved.png") });
    await sheet
      .getByRole("button", { name: "Close", exact: true })
      .filter({ hasText: /^Close$/ })
      .click();
    expect(await readFile(repair.configPath)).toEqual(originalConfig);
  },
);

// Smallest valid square PNG the daemon will accept as a custom project icon.
const PNG_1X1 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00,
]);

interface ProjectsSettingsProject {
  name: string;
  path: string;
}

interface ProjectsSettingsFixtures {
  editableProject: ProjectsSettingsProject;
  gitlabRemoteProject: ProjectsSettingsProject;
}

const initialPaseoConfig = {
  worktree: {
    setup: ["echo initial setup"],
    teardown: "echo cleanup",
    customWorktreeField: "preserved",
  },
  scripts: {
    dev: {
      command: "npm run dev",
      type: "server",
      port: 3000,
      customScriptField: "preserved",
    },
  },
  customTopLevelField: "preserved",
};

const test = base.extend<ProjectsSettingsFixtures>({
  editableProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "projects-settings-",
      repo: { paseoConfig: initialPaseoConfig },
    });

    await provide({
      name: workspace.projectDisplayName,
      path: workspace.repoPath,
    });

    // Defensive: restore directory write permission in case the test left it blocked
    // (write_failed test), so that cleanup can remove files inside.
    await chmod(workspace.repoPath, 0o755).catch(() => undefined);
    await workspace.cleanup();
  },
  gitlabRemoteProject: async ({ page: _page }, provide) => {
    const workspace = await seedWorkspace({
      repoPrefix: "projects-settings-gitlab-",
      repo: {
        paseoConfig: initialPaseoConfig,
        originUrl: "https://gitlab.com/acme/app.git",
      },
    });

    await provide({
      name: workspace.projectDisplayName,
      path: workspace.repoPath,
    });

    await workspace.cleanup();
  },
});

async function expectProjectConfigSaved(project: ProjectsSettingsProject): Promise<void> {
  await expect
    .poll(
      async () => {
        const contents = await readProjectConfigFile(project);
        return JSON.parse(contents) as unknown;
      },
      {
        timeout: 30_000,
      },
    )
    .toMatchObject({
      worktree: {
        setup: updatedSetup,
        teardown: initialPaseoConfig.worktree.teardown,
        customWorktreeField: initialPaseoConfig.worktree.customWorktreeField,
      },
      scripts: {
        dev: {
          command: initialPaseoConfig.scripts.dev.command,
          type: initialPaseoConfig.scripts.dev.type,
          port: initialPaseoConfig.scripts.dev.port,
          customScriptField: initialPaseoConfig.scripts.dev.customScriptField,
        },
      },
      customTopLevelField: initialPaseoConfig.customTopLevelField,
    });

  const savedConfig = await readProjectConfigFile(project);
  expect(savedConfig).toBe(`${JSON.stringify(JSON.parse(savedConfig), null, 2)}\n`);
}

async function readProjectConfigFile(project: ProjectsSettingsProject): Promise<string> {
  return readFile(path.join(project.path, "paseo.json"), "utf8");
}

async function addProjectFromSidebar(page: Page, projectPath: string): Promise<string> {
  await openAddProjectFlow(page);
  await chooseAddProjectMethod(page, "directory-search");

  const input = addProjectFlowInput(page);
  await input.fill(projectPath);
  await page.keyboard.press("Enter");

  const projectRow = page
    .locator('[data-testid^="sidebar-project-row-"]')
    .filter({ hasText: path.basename(projectPath) })
    .first();
  await expect(projectRow).toBeVisible({ timeout: 30_000 });

  const testId = await projectRow.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  return testId!.replace("sidebar-project-row-", "");
}

async function openProjectSettingsFromSidebar(page: Page, projectId: string): Promise<void> {
  const projectRow = page.getByTestId(`sidebar-project-row-${projectId}`);
  await expect(projectRow).toBeVisible({ timeout: 30_000 });
  await projectRow.hover();

  const kebab = page.getByTestId(`sidebar-project-kebab-${projectId}`);
  await expect(kebab).toBeVisible({ timeout: 10_000 });
  await kebab.click();

  const openSettingsItem = page.getByTestId(`sidebar-project-menu-open-settings-${projectId}`);
  await expect(openSettingsItem).toBeVisible({ timeout: 10_000 });
  await openSettingsItem.click();
}

test.describe("Projects settings", () => {
  test("freshly-added project with no workspace is editable from the sidebar without a reload", async ({
    page,
  }) => {
    const repo = await createTempGitRepo("projects-settings-empty-");
    const client = await connectSeedClient();
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);

      projectId = await addProjectFromSidebar(page, repo.path);
      await openProjectSettingsFromSidebar(page, projectId);

      await expectProjectSettingsFormVisible(page);
      await expect(page.getByTestId("project-settings-back-button")).not.toBeVisible();
    } finally {
      if (projectId) {
        await client.removeProject(projectId).catch(() => undefined);
      }
      await client.close().catch(() => undefined);
      await repo.cleanup().catch(() => undefined);
    }
  });

  test("user edits worktree setup from the projects page", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await expectNoUncommittedSetupWarning(page);
    await editWorktreeSetup(page, updatedSetup);
    await clickSaveProjectSettings(page);
    await expectProjectConfigSaved(editableProject);
    await expectUncommittedSetupWarning(page);

    commitPaseoConfig(editableProject.path);
    await returnToProjectsList(page);
    await openProjectSettings(page, editableProject.name);
    await expectNoUncommittedSetupWarning(page);
  });

  test("project navigation stays inside the selected host", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await expectProjectHostContextHidden(page);
    await returnToProjectsList(page);
    await openProjectSettings(page, editableProject.name);
    await expectProjectSettingsHistoryRoundTrip(page, editableProject.name);
  });

  test("user edits worktree setup on a non-GitHub remote project", async ({
    page,
    gitlabRemoteProject,
  }) => {
    expect(gitlabRemoteProject.name).toBe(path.basename(gitlabRemoteProject.path));
    await openProjects(page);
    await openProjectSettings(page, gitlabRemoteProject.name);
    await editWorktreeSetup(page, updatedSetup);
    await clickSaveProjectSettings(page);
    await expectProjectConfigSaved(gitlabRemoteProject);
  });

  test("user renames a project from the edit sheet", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectName(page, "Renamed project");
    await saveProjectEdits(page);

    await expectProjectEditSaved(page);
    await expectProjectTitle(page, "Renamed project");
  });

  test("reopening the edit sheet seeds from the saved project", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectName(page, "Renamed project");
    await saveProjectEdits(page);
    await expectProjectEditSaved(page);

    await openProjectEditSheet(page);

    await expectProjectEditName(page, "Renamed project");
    await expectProjectEditsSaveDisabled(page);
  });

  test("user picks a custom project icon from a file", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await chooseProjectIconImage(page, {
      name: "logo.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await saveProjectEdits(page);

    await expectProjectEditSaved(page);
  });

  test("user sets a project name and icon in one save", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectName(page, "Both at once");
    await chooseProjectIconImage(page, {
      name: "logo.png",
      mimeType: "image/png",
      buffer: PNG_1X1,
    });
    await saveProjectEdits(page);

    await expectProjectEditSaved(page);
    await expectProjectTitle(page, "Both at once");
  });

  test("project edit keeps a rejected icon URL actionable", async ({ page, editableProject }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);
    await openProjectEditSheet(page);
    await fillProjectIconUrl(page, "file:///etc/passwd");
    await saveProjectEdits(page);

    await expectProjectEditFailed(page, "URL must use HTTP or HTTPS without credentials");
  });
});

test.describe("Projects settings — compact navigation", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("project Back returns through Projects and Settings without reopening the project", async ({
    page,
    editableProject,
  }) => {
    await gotoAppShell(page);
    await openCompactSettings(page, buildOpenProjectRoute());
    await page.getByRole("button", { name: "Projects", exact: true }).click();
    await expect(page).toHaveURL(buildProjectsSettingsRoute(getServerId()));

    await openProjectSettings(page, editableProject.name);
    await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Back to projects", exact: true })).toHaveCount(
      0,
    );

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(buildProjectsSettingsRoute(getServerId()));

    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(page).toHaveURL(buildSettingsRoute());
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
  });
});

test.describe("Projects settings — error UX", () => {
  test("stale-write callout appears on save, disables save, and reload clears it", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Bump the file on disk so the daemon detects a revision mismatch on save.
    await bumpPaseoConfigOnDisk(editableProject.path);

    await clickSaveProjectSettings(page);

    await expectProjectSettingsError(page, "stale");
    await expectSaveButtonDisabled(page);

    await clickReloadProjectSettings(page);

    await expectNoProjectSettingsError(page, "stale");
    await expectProjectSettingsFormVisible(page);
  });

  test("invalid paseo.json shows read-error callout, reload after fix shows form", async ({
    page,
    editableProject,
  }) => {
    await corruptPaseoConfig(editableProject.path);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "invalid");
    await expectProjectSettingsFormHidden(page);

    // Restore a valid config so the reload succeeds.
    await restorePaseoConfig(editableProject.path, initialPaseoConfig);

    await clickReloadProjectSettings(page);

    await expectNoProjectSettingsError(page, "invalid");
    await expectProjectSettingsFormVisible(page);
  });

  test("write_failed callout appears on save with blocked directory, retry re-attempts, reload clears it", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await blockPaseoConfigWrites(editableProject.path);

    await clickSaveProjectSettings(page);

    await expectProjectSettingsError(page, "write_failed");
    await expectWriteFailedCalloutActions(page);

    await clickRetryProjectSettingsSave(page);
    await expectProjectSettingsError(page, "write_failed");

    await unblockPaseoConfigWrites(editableProject.path);
    await clickReloadProjectSettings(page);
    await expectNoProjectSettingsError(page, "write_failed");
    await expectProjectSettingsFormVisible(page);
  });

  test("read-transport failure shows callout, reload recovers", async ({
    page,
    editableProject,
  }) => {
    // Reject read_project_config_request calls until the user clicks Reload.
    // This keeps automatic reconnect refetches from racing past the callout.
    const transportFailure = await installReadTransportFailure(page);

    await openProjects(page);
    await navigateToProjectSettings(page, editableProject.name);

    await expectProjectSettingsError(page, "transport");
    await expectProjectSettingsFormHidden(page);

    // Retry Reload until the refetch wins any in-flight error-state rendering.
    transportFailure.allowRecovery();
    await expect(async () => {
      await clickReloadProjectSettings(page);
      await expectNoProjectSettingsError(page, "transport", 3_000);
    }).toPass({ timeout: 15_000 });
    await expectProjectSettingsFormVisible(page);
  });

  test("project settings shows no-target state when daemon connection drops", async ({
    page,
    editableProject,
  }) => {
    const gate = await installDaemonConnectionGate(page);

    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    // Closing with code 1001 (Going Away) transitions DaemonClient to "error" state.
    // The NoEditableTarget UI renders via isHostGone check regardless of state.
    await gate.drop();

    await expectNoEditableTarget(page);
  });

  test("project detail does not render a second host selector", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await expectProjectHostContextHidden(page);
  });

  test("script removal via kebab menu removes the row from the form", async ({
    page,
    editableProject,
  }) => {
    await openProjects(page);
    await openProjectSettings(page, editableProject.name);

    await expectScriptRowCount(page, 1);

    await removeProjectScript(page, "dev");

    await expectScriptRowCount(page, 0);
    await expectEmptyScriptList(page);
    await clickSaveProjectSettings(page);
    await expectNoUncommittedSetupWarning(page);
  });
});
