import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Page, TestInfo } from "@playwright/test";
import path from "node:path";
import {
  buildHostWorkspaceRoute,
  buildProjectsSettingsRoute,
  buildProjectSettingsRoute,
} from "@/utils/host-routes";
import { expect, test } from "../support/fixtures";
import {
  repairTest,
  openRepairWorkspace,
  type RepairDaemon,
  type MixedRepairEvidence,
  type RepairPair,
} from "../support/helpers/swarm-test-daemon";
import { openProjectSettings } from "../support/helpers/project-settings";
import type { AgentRecord } from "../../../../plugins/paseo-swarm/shared/models";
import { gotoAppShell, openSettings } from "../support/helpers/app";
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

repairTest(
  "Swarm repair: real planner and supervisor creation with inherited legacy PWA",
  async ({ page, repair }, testInfo) => {
    repairTest.setTimeout(210_000);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRepairWorkspace(page, repair);
    await page
      .getByTestId("swarm-sidebar-mode")
      .filter({ visible: true })
      .getByText("Swarm", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add planner", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/swarmRoleClass=planner/);
    await expect(page.getByTestId("new-workspace-project-picker-trigger")).toContainText(
      repair.projectName,
    );
    await page.getByRole("textbox", { name: "Agent name", exact: true }).fill("qa-created-planner");
    await page.getByRole("button", { name: "Swarm role", exact: true }).click();
    await expect(page.getByRole("button", { name: "Legacy planner", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Legacy planner", exact: true }).click();
    await expect(page.getByRole("button", { name: "Parent planner", exact: true })).toHaveCount(0);
    await selectWorkspaceIsolation(page, "worktree");
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-planner-wizard.png") });
    await submitNewWorkspacePrompt(page, "Private repair fixture: verify planner creation only.");
    const readAgents = async () =>
      ((await repair.invoke("swarm.board.read", {})) as { agents: AgentRecord[] }).agents;
    await expect
      .poll(
        async () =>
          (await readAgents()).find((agent) => agent.name === "qa-created-planner")?.workspaceId,
      )
      .toBeTruthy();
    const planner = (await readAgents()).find((agent) => agent.name === "qa-created-planner")!;
    expect(planner.reportsTo).toBeNull();
    expect(planner.pwaBinding?.directory).toBe(repair.legacyRoot);
    expect(repair.nativePrompt(planner.paseoAgentId)).toContain("Legacy planner guidance.");
    expect(repair.nativePrompt(planner.paseoAgentId)).toContain("Legacy working agreement.");
    await expect(page).toHaveURL(/\/workspace\//);

    await openRepairWorkspace(page, repair);
    const original = repair.agents.find((agent) => agent.qualifiedName === "qa-planner")!;
    await page
      .getByTestId(`swarm-planner-row-${original.paseoAgentId}`)
      .filter({ visible: true })
      .hover();
    await page
      .getByRole("button", { name: "Add supervisor under qa-planner", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/swarmRoleClass=supervisor/);
    await expect(page.getByRole("button", { name: "Parent planner", exact: true })).toContainText(
      "qa-planner",
    );
    await expect(
      page.getByText(`Inherited PWA · ${repair.legacyRoot}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm parent PWA binding", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .fill("qa-created-supervisor");
    await page.getByRole("button", { name: "Swarm role", exact: true }).click();
    await page.getByRole("button", { name: "Legacy supervisor", exact: true }).click();
    await page.getByRole("button", { name: "Parent planner", exact: true }).click();
    const parentPicker = page.getByRole("dialog");
    await expect(parentPicker).toBeVisible();
    await expect(
      parentPicker.getByRole("button", { name: "qa-planner-outsider", exact: true }),
    ).toHaveCount(0);
    await parentPicker.getByRole("button", { name: "qa-planner", exact: true }).click();
    await selectWorkspaceIsolation(page, "worktree");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("textbox", { name: "Agent name", exact: true })).toHaveValue(
      "qa-created-supervisor",
    );
    await expect(page.getByRole("button", { name: "Swarm role", exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-supervisor-wizard-390.png") });
    await submitNewWorkspacePrompt(
      page,
      "Private repair fixture: verify supervisor creation only.",
    );
    await expect
      .poll(
        async () =>
          (await readAgents()).find((agent) => agent.name === "qa-created-supervisor")?.workspaceId,
      )
      .toBeTruthy();
    const supervisor = (await readAgents()).find(
      (agent) => agent.name === "qa-created-supervisor",
    )!;
    expect(supervisor.reportsTo).toBe("qa-planner");
    expect(supervisor.workspaceId).not.toBe(original.workspaceId);
    expect(supervisor.pwaBinding?.directory).toBe(repair.legacyRoot);
    const native = await repair.client.fetchAgent(supervisor.paseoAgentId);
    expect(native?.agent.labels["paseo.parent-agent-id"]).toBe(original.paseoAgentId);
    expect(repair.nativePrompt(supervisor.paseoAgentId)).toContain("Legacy supervisor guidance.");
    expect(
      (await readAgents()).find((agent) => agent.qualifiedName === "qa-planner")?.pwaBinding,
    ).toBeUndefined();
  },
);

const bindFaultTest = repairTest.extend({ repairFault: "wizard-bind" as const });

bindFaultTest(
  "Swarm repair fault: ordinary Draft Composer retries the same prepared native workspace",
  async ({ page, repair }, testInfo) => {
    bindFaultTest.setTimeout(210_000);
    const fault = repair.fault!;
    const parent = repair.agents.find((agent) => agent.qualifiedName === "qa-planner")!;
    const readAgents = async () =>
      ((await repair.invoke("swarm.board.read", {})) as { agents: AgentRecord[] }).agents;
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRepairWorkspace(page, repair);
    await page
      .getByTestId("swarm-sidebar-mode")
      .filter({ visible: true })
      .getByText("Swarm", { exact: true })
      .click();
    expect(
      fault.evidence.rpc.filter(
        (entry) =>
          entry.method === "swarm.pwa_roles.read" || entry.method === "swarm.agent.prepare",
      ),
    ).toHaveLength(0);
    fault.holdColdTarget();
    await page
      .getByTestId(`swarm-planner-row-${parent.paseoAgentId}`)
      .filter({ visible: true })
      .hover();
    await page
      .getByRole("button", { name: "Add supervisor under qa-planner", exact: true })
      .filter({ visible: true })
      .click();
    await expect(page).toHaveURL(/swarmRoleClass=supervisor/);
    expect(new URL(page.url()).searchParams.get("swarmParent")).toBe("qa-planner");
    await expect
      .poll(() => {
        for (const label of ["cold-source", "cold-board"]) {
          if (
            !fault.evidence.events.some(
              (entry) => entry.action === "reply-held" && entry.label === label,
            )
          ) {
            return false;
          }
        }
        return true;
      })
      .toBe(true);
    fault.assertColdTargetHealthy();
    await expect(page.getByTestId("swarm-target-error")).toContainText(
      "Wait for PWA roles to load.",
    );
    expect(
      fault.evidence.rpc.filter((entry) => entry.method === "swarm.agent.prepare"),
    ).toHaveLength(0);
    const coldStatus = page.getByTestId("swarm-target-error").filter({ visible: true });
    const coldRetry = coldStatus
      .getByTestId("swarm-target-retry")
      .and(page.getByRole("button", { name: "Retry", exact: true }));
    await expect(coldStatus).toHaveCount(1);
    await expect(coldStatus).toBeInViewport({ ratio: 1 });
    await expect(
      coldStatus.getByText("Wait for PWA roles to load.", { exact: true }),
    ).toBeInViewport({ ratio: 1 });
    await expect(coldRetry).toHaveCount(1);
    await expect(coldRetry).toBeInViewport({ ratio: 1 });
    await coldRetry.click({ trial: true });
    const assertColdFrame = async () => {
      fault.assertColdTargetHealthy();
      const title = coldStatus.getByText("Wait for PWA roles to load.", { exact: true });
      await expect(title).toHaveCount(1);
      await expect(title).toHaveText("Wait for PWA roles to load.");
      await expect(title).toBeVisible();
      await expect(coldStatus).toHaveText(/^\s*Wait for PWA roles to load\.\s*Retry\s*$/);
      expect(
        fault.evidence.rpc.filter((entry) => entry.method === "swarm.agent.prepare"),
      ).toHaveLength(0);
      fault.assertColdTargetHealthy();
    };
    await assertColdFrame();
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-cold-parent-loading.png") });
    await assertColdFrame();
    fault.release("cold-board");
    fault.release("cold-source");
    const parentTrigger = page.getByRole("button", { name: "Parent planner", exact: true });
    await expect(parentTrigger).toContainText("qa-planner");
    await expect(
      page.getByText(`Inherited PWA · ${repair.legacyRoot}`, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Confirm parent PWA binding", exact: true }),
    ).toHaveCount(0);
    await parentTrigger.click();
    const parentDialog = page.getByRole("dialog").filter({ visible: true });
    await expect(parentDialog).toHaveCount(1);
    await expect(
      parentDialog.getByRole("button", { name: "qa-planner-outsider", exact: true }),
    ).toHaveCount(0);
    await expect(parentDialog.getByRole("button", { name: "qa-other", exact: true })).toBeVisible();
    await parentDialog.getByRole("button", { name: "qa-planner", exact: true }).click();
    await page
      .getByRole("textbox", { name: "Agent name", exact: true })
      .fill("qa-fault-supervisor");
    await page.getByRole("button", { name: "Swarm role", exact: true }).click();
    const roleDialog = page.getByRole("dialog").filter({ visible: true });
    await roleDialog.getByRole("button", { name: "Legacy supervisor", exact: true }).click();
    await selectWorkspaceIsolation(page, "worktree");
    await fault.disconnectNextBind();
    const prompt =
      "Private repair fault fixture: retain the same supervisor creation after final binding disconnect.";
    await submitNewWorkspacePrompt(page, prompt);
    await expect.poll(() => fault.evidence.disconnects.length).toBe(1);
    const prepares = fault.evidence.rpc.filter((entry) => entry.method === "swarm.agent.prepare");
    expect(prepares).toHaveLength(1);
    const prepared = prepares[0]!.prepared!;
    expect(prepared).toBeDefined();
    expect(prepared.parentAgentId).toBe(parent.paseoAgentId);
    expect(prepared.systemPrompt).toContain("Legacy supervisor guidance.");
    expect(prepared.systemPrompt).toContain("Legacy working agreement.");
    expect(prepares[0]!.input.reportsTo).toBe("qa-planner");
    expect(fault.evidence.creations).toHaveLength(1);
    const created = fault.evidence.creations[0]!;
    const workspaceId = created.response?.workspaceId;
    expect(workspaceId).toBeTruthy();
    expect(created.response?.agentId).toBe(prepared.agentId);
    expect(created.response?.error).toBeNull();
    expect(created.systemPrompt).toBe(prepared.systemPrompt);
    expect(repair.nativePrompt(prepared.agentId)).toBe(prepared.systemPrompt);
    const rejected = fault.evidence.rpc.find(
      (entry) => entry.requestId === fault.evidence.disconnects[0]!.requestId,
    )!;
    expect(rejected.method).toBe("swarm.agent.bind_workspace");
    expect(rejected.dispatched).toBe(false);
    expect(rejected.input).toEqual({ agentId: prepared.agentId, workspaceId });
    expect(rejected.responseUtc).toBeUndefined();
    const reserved = (await readAgents()).find((agent) => agent.paseoAgentId === prepared.agentId)!;
    expect(reserved.workspaceId).toBeNull();
    const nativeBefore = await repair.client.fetchAgent(prepared.agentId);
    expect(nativeBefore?.agent.workspaceId).toBe(workspaceId);
    expect(nativeBefore?.agent.labels["paseo.parent-agent-id"]).toBe(parent.paseoAgentId);
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}(?:[/?#]|$)`));
    const composer = page
      .getByRole("textbox", { name: "Message agent...", exact: true })
      .filter({ visible: true });
    const draftPane = page
      .getByTestId(/^workspace-pane-/)
      .filter({ visible: true })
      .filter({ has: composer });
    await expect(draftPane).toHaveCount(1);
    await expect(
      draftPane.getByText(new RegExp(`^Prepared agent ${prepared.agentId}:`)),
    ).toBeVisible();
    await expect(composer).toBeEditable();
    await expect(composer).toHaveValue(prompt);
    await page.screenshot({ path: testInfo.outputPath("swarm-repair-draft-bind-error.png") });
    await expect.poll(() => fault.reconnectObserved()).toBe(true);
    const submit = draftPane.getByRole("button", { name: "Send message", exact: true });
    await expect(submit).toBeEnabled();
    // Ordinary same-session Draft Composer submission; no reprepare, fresh wizard or direct bind.
    await submit.click();
    await expect
      .poll(
        () =>
          fault.evidence.rpc.filter(
            (entry) =>
              entry.method === "swarm.agent.bind_workspace" && entry.bound && entry.replyForwarded,
          ).length,
      )
      .toBe(1);
    const binds = fault.evidence.rpc.filter(
      (entry) => entry.method === "swarm.agent.bind_workspace",
    );
    expect(binds).toHaveLength(2);
    expect(binds[1]!.requestId).not.toBe(rejected.requestId);
    expect(binds[1]!.dispatched).toBe(true);
    expect(binds[1]!.input).toEqual(rejected.input);
    expect(binds[1]!.bound).toMatchObject({
      agentId: prepared.agentId,
      workspaceId,
      reportsTo: "qa-planner",
      projectId: repair.projectId,
    });
    expect(fault.evidence.creations).toHaveLength(2);
    const replay = fault.evidence.creations[1]!;
    expect(replay.requestId).not.toBe(created.requestId);
    expect(replay.idempotencyKey).toBe(created.idempotencyKey);
    expect(replay.intentSha256).toBe(created.intentSha256);
    expect(replay.agentId).toBe(prepared.agentId);
    expect(replay.systemPrompt).toBe(prepared.systemPrompt);
    expect(replay.response).toEqual(created.response);
    expect(
      fault.evidence.rpc.filter((entry) => entry.method === "swarm.agent.prepare"),
    ).toHaveLength(1);
    expect(
      fault.evidence.rpc.filter((entry) => entry.method === "swarm.agent.bind_pwa"),
    ).toHaveLength(0);
    const actual = await readAgents();
    const children = actual.filter((agent) => agent.name === "qa-fault-supervisor");
    expect(children).toHaveLength(1);
    expect(children[0]!.paseoAgentId).toBe(prepared.agentId);
    expect(children[0]!.workspaceId).toBe(workspaceId);
    expect(children[0]!.reportsTo).toBe("qa-planner");
    expect(
      actual.find((agent) => agent.paseoAgentId === parent.paseoAgentId)?.pwaBinding,
    ).toBeUndefined();
    expect(repair.nativePrompt(prepared.agentId)).toBe(prepared.systemPrompt);
    const nativeAfter = await repair.client.fetchAgent(prepared.agentId);
    expect(nativeAfter?.agent.workspaceId).toBe(workspaceId);
    expect(nativeAfter?.agent.labels["paseo.parent-agent-id"]).toBe(parent.paseoAgentId);
    await expect(
      draftPane.getByText(new RegExp(`^Prepared agent ${prepared.agentId}:`)),
    ).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspaceId}(?:[/?#]|$)`));
    await page.screenshot({
      path: testInfo.outputPath("swarm-repair-same-reservation-recovered.png"),
    });
  },
);

async function chooseMixedScope(page: Page, label: string) {
  const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
  // DropdownTrigger owns an accessible label but does not promise a button role.
  const trigger = surface.getByLabel("Scope", { exact: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(trigger).toContainText(label);
}

async function openMixedPlannerBoard(page: Page, repair: RepairDaemon, plannerName: string) {
  const planner = repair.agents.find((agent) => agent.qualifiedName === plannerName)!;
  await page.goto(buildHostWorkspaceRoute(repair.serverId, planner.workspaceId!));
  await page
    .getByTestId("swarm-sidebar-mode")
    .filter({ visible: true })
    .getByText("Swarm", { exact: true })
    .click();
  await page
    .getByTestId(`swarm-planner-tasks-${planner.paseoAgentId}`)
    .filter({ visible: true })
    .click();
  await expect(page.getByTestId("swarm-task-surface").filter({ visible: true })).toHaveCount(1);
  await chooseMixedScope(page, "Project");
}

async function selectMixedPlannerBoard(page: Page, repair: RepairDaemon, plannerName: string) {
  const planner = repair.agents.find((agent) => agent.qualifiedName === plannerName)!;
  const tasks = page
    .getByTestId(`swarm-planner-tasks-${planner.paseoAgentId}`)
    .and(page.getByRole("button", { name: `Open ${planner.name} Tasks`, exact: true }))
    .filter({ visible: true });
  await expect(tasks).toHaveCount(1);
  await expect(tasks).toBeVisible();
  await expect(tasks).toBeEnabled();
  await tasks.click();
  await expect(page).toHaveURL(buildHostWorkspaceRoute(repair.serverId, planner.workspaceId!));
  await expect(page.getByTestId("swarm-task-surface").filter({ visible: true })).toHaveCount(1);
  await chooseMixedScope(page, "Project");
}

async function openMixedProjects(page: Page, repair: RepairDaemon) {
  await openSettings(page);
  const projects = page
    .getByTestId("settings-sidebar")
    .getByRole("button", { name: "Projects", exact: true })
    .filter({ visible: true });
  await expect(projects).toHaveCount(1);
  await expect(projects).toBeVisible();
  await expect(projects).toBeEnabled();
  await projects.click();
  await expect(page).toHaveURL(buildProjectsSettingsRoute(repair.serverId));
}

async function returnMixedBoardFromSettings(page: Page, repair: RepairDaemon) {
  const back = page
    .getByTestId("settings-back-to-workspace")
    .and(page.getByRole("button", { name: "Back", exact: true }))
    .filter({ visible: true });
  await expect(back).toHaveCount(1);
  await expect(back).toBeVisible();
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page).toHaveURL(buildHostWorkspaceRoute(repair.serverId, repair.workspaceId));
  await expect(page.getByTestId("swarm-task-surface").filter({ visible: true })).toHaveCount(1);
}

async function assertMixedProjectIsolation(
  page: Page,
  repair: RepairDaemon,
  mixed: MixedRepairEvidence,
  testInfo: TestInfo,
) {
  const task = (id: string) => page.getByTestId(`swarm-task-${id}`).filter({ visible: true });
  const knownMainIds = ["qa-survey", "qa-completed", "qa-nested", "qa-queued", "qa-historical"];
  await openMixedPlannerBoard(page, repair, "qa-planner");
  for (const id of knownMainIds) await expect(task(id)).toHaveCount(1);
  await expect(task("qa-foreign")).toHaveCount(0);
  await task("qa-historical").click();
  const detail = page.getByTestId("swarm-task-detail").filter({ visible: true });
  await expect(detail).toContainText("historic-review");
  await expect(detail.getByTestId("swarm-activity-activity-qa-historical")).toContainText(
    "Retained Activity for qa-historical.",
  );
  await page.screenshot({ path: testInfo.outputPath("mixed-main-project-activity.png") });
  await detail.getByTestId("swarm-task-back").click();
  await chooseMixedScope(page, "Supervisor · qa-planner.left");
  await expect(task("qa-survey")).toHaveCount(1);
  await expect(task("qa-nested")).toHaveCount(1);
  await expect(task("qa-completed")).toHaveCount(0);
  await expect(task("qa-queued")).toHaveCount(0);
  await chooseMixedScope(page, "Planner · qa-other");
  await expect(task("qa-queued")).toHaveCount(1);
  await expect(task("qa-survey")).toHaveCount(0);
  await chooseMixedScope(page, "Project");
  await page
    .getByTestId("swarm-task-surface")
    .filter({ visible: true })
    .getByLabel("Scope", { exact: true })
    .click();
  await expect(page.getByRole("menuitem", { name: "Unattributed Tasks", exact: true })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("menuitem", { name: "Planner · qa-planner-outsider", exact: true }),
  ).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("mixed-main-project-scope.png") });
  await page.getByRole("menuitem", { name: "Project", exact: true }).click();
  await selectMixedPlannerBoard(page, repair, "qa-planner-outsider");
  await expect(task("qa-foreign")).toHaveCount(1);
  for (const id of knownMainIds) await expect(task(id)).toHaveCount(0);
  await task("qa-foreign").click();
  await expect(detail.getByTestId("swarm-activity-activity-qa-foreign")).toContainText(
    "Retained Activity for qa-foreign.",
  );
  await page.screenshot({ path: testInfo.outputPath("mixed-foreign-project-activity.png") });
  await detail.getByTestId("swarm-task-back").click();
  await page
    .getByTestId("swarm-task-surface")
    .filter({ visible: true })
    .getByLabel("Scope", { exact: true })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Planner · qa-planner", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("menuitem", { name: "Project", exact: true }).click();
  const foreignProject = repair.agents.find(
    (agent) => agent.qualifiedName === "qa-planner-outsider",
  )!.projectId!;
  for (const projectId of [repair.projectId, foreignProject]) {
    await expect
      .poll(
        () =>
          mixed.rpc.filter(
            (entry) =>
              entry.method === "swarm.board.read" &&
              entry.input.projectId === projectId &&
              entry.board,
          ).length,
      )
      .toBeGreaterThan(0);
    const observation = mixed.rpc.find(
      (entry) =>
        entry.method === "swarm.board.read" && entry.input.projectId === projectId && entry.board,
    )!;
    expect(observation.input).toEqual({ projectId });
    expect(observation.board!.taskIds).toEqual(repair.initial.tasks.map((row) => row.id).sort());
    expect(observation.board!.activityIds).toEqual(
      repair.initial.activities.map((row) => row.id).sort(),
    );
    repair.recordMixedEvidence({
      kind: "Project wire/full versus visible isolation",
      projectId,
      socketId: observation.socketId,
      requestId: observation.requestId,
      uri: observation.uri,
      rawTaskIds: observation.board!.taskIds,
      rawActivityIds: observation.board!.activityIds,
    });
  }
  const boardRequests = mixed.rpc.filter((entry) => entry.method === "swarm.board.read");
  expect(
    boardRequests.some(
      (entry) => Object.hasOwn(entry.input, "teamName") || Object.hasOwn(entry.input, "unassigned"),
    ),
  ).toBe(false);
  await selectMixedPlannerBoard(page, repair, "qa-planner");
  for (const id of knownMainIds) await expect(task(id)).toHaveCount(1);
  await expect(task("qa-foreign")).toHaveCount(0);
}

async function assertMixedLegacyWizard(
  page: Page,
  repair: RepairDaemon,
  mixed: MixedRepairEvidence,
  testInfo: TestInfo,
) {
  const parent = repair.agents.find((agent) => agent.qualifiedName === "qa-planner")!;
  await expect(page).toHaveURL(buildHostWorkspaceRoute(repair.serverId, parent.workspaceId!));
  await expect(page.getByTestId("swarm-task-surface").filter({ visible: true })).toHaveCount(1);
  await page
    .getByTestId(`swarm-planner-row-${parent.paseoAgentId}`)
    .filter({ visible: true })
    .hover();
  await page
    .getByRole("button", { name: "Add supervisor under qa-planner", exact: true })
    .filter({ visible: true })
    .click();
  await expect(page).toHaveURL(/swarmRoleClass=supervisor/);
  await expect(page.getByTestId("new-workspace-project-picker-trigger")).toContainText(
    repair.projectName,
  );
  await expect(page.getByRole("button", { name: "Parent planner", exact: true })).toContainText(
    "qa-planner",
  );
  await expect(
    page.getByRole("button", { name: "Confirm parent PWA binding", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("textbox", { name: "Agent name", exact: true }).fill("qa-mixed-supervisor");
  await page.getByRole("button", { name: "Swarm role", exact: true }).click();
  await expect(page.getByRole("button", { name: "Legacy supervisor", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Legacy supervisor", exact: true }).click();
  await selectWorkspaceIsolation(page, "worktree");
  await page.screenshot({ path: testInfo.outputPath("mixed-legacy-supervisor-wizard.png") });
  await submitNewWorkspacePrompt(
    page,
    "Private mixed fixture: verify supervisor prepare/create/bind only.",
  );
  await expect
    .poll(
      () =>
        mixed.rpc.filter((entry) => entry.method === "swarm.agent.bind_workspace" && entry.bound)
          .length,
    )
    .toBe(1);
  const prepares = mixed.rpc.filter((entry) => entry.method === "swarm.agent.prepare");
  const binds = mixed.rpc.filter((entry) => entry.method === "swarm.agent.bind_workspace");
  expect(prepares).toHaveLength(1);
  expect(binds).toHaveLength(1);
  expect(mixed.creations).toHaveLength(1);
  const prepare = prepares[0];
  expect(prepare.error).toBeUndefined();
  expect(prepare.input.name).toBe("qa-mixed-supervisor");
  expect(prepare.input.projectId).toBe(repair.projectId);
  expect(prepare.input.reportsTo).toBe("qa-planner");
  const prepared = prepare.prepared!;
  expect(prepared.systemPrompt).toContain("Legacy supervisor guidance.");
  expect(prepared.systemPrompt).toContain("Legacy working agreement.");
  const created = mixed.creations[0];
  expect(created.agentId).toBe(prepared.agentId);
  expect(created.systemPrompt).toBe(prepared.systemPrompt);
  expect(created.sha256).toBe(prepared.sha256);
  expect(created.bytes).toBe(prepared.bytes);
  expect(created.parentLabelPresent).toBe(false);
  expect(created.parentLabel).toBeUndefined();
  expect(binds[0].error).toBeUndefined();
  expect(binds[0].input.agentId).toBe(prepared.agentId);
  const bound = binds[0].bound!;
  expect(bound.agentId).toBe(prepared.agentId);
  expect(bound.reportsTo).toBe("qa-planner");
  expect(bound.projectId).toBe(repair.projectId);
  expect(bound.workspaceId).not.toBeNull();
  expect(bound.workspaceId).not.toBe(parent.workspaceId);
  expect(binds[0].input.workspaceId).toBe(bound.workspaceId);
  await expect.poll(() => created.response?.workspaceId).toBe(bound.workspaceId);
  expect(created.response?.error).toBeNull();
  expect(created.response?.agentId).toBe(prepared.agentId);
  const native = await repair.client.fetchAgent(prepared.agentId);
  expect(native?.agent.id).toBe(prepared.agentId);
  expect(native?.agent.workspaceId).toBe(bound.workspaceId);
  expect(native?.agent.labels["paseo.parent-agent-id"]).toBeUndefined();
  expect(repair.nativePrompt(prepared.agentId)).toBe(prepared.systemPrompt);
  const actualAgents = ((await repair.invoke("swarm.board.read", {})) as { agents: AgentRecord[] })
    .agents;
  const children = actualAgents.filter((agent) => agent.name === "qa-mixed-supervisor");
  expect(children).toHaveLength(1);
  expect(children[0].paseoAgentId).toBe(prepared.agentId);
  expect(children[0].workspaceId).toBe(bound.workspaceId);
  expect(
    actualAgents.find((agent) => agent.qualifiedName === "qa-planner")?.pwaBinding,
  ).toBeUndefined();
  expect(mixed.rpc.filter((entry) => entry.method === "swarm.agent.bind_pwa")).toEqual([]);
  const roles = mixed.rpc.filter(
    (entry) =>
      entry.method === "swarm.pwa_roles.read" &&
      entry.input.roleClass === "supervisor" &&
      entry.input.projectId === repair.projectId,
  );
  expect(roles.length).toBeGreaterThan(0);
  expect(
    roles.some((entry) => entry.roles?.some((role) => role.title === "Legacy supervisor")),
  ).toBe(true);
  if (mixed.pair === "old-app/current-core") {
    expect(prepared.parentAgentId).toBe(parent.paseoAgentId);
    expect(children[0].pwaBinding).toEqual({
      projectId: repair.projectId,
      contentRoot: repair.legacyRoot,
      directory: repair.legacyRoot,
    });
    for (const entry of roles)
      expect(entry.input).toEqual({ projectId: repair.projectId, roleClass: "supervisor" });
  } else {
    expect(Object.hasOwn(prepared, "parentAgentId")).toBe(false);
    expect(children[0].pwaBinding).toBeUndefined();
  }
  await expect(page).toHaveURL(/\/workspace\//);
  await page.screenshot({ path: testInfo.outputPath("mixed-bound-supervisor-workspace.png") });
  repair.recordMixedEvidence({
    kind: "Actual UI U/P/W equality",
    pair: mixed.pair,
    prepareRequestId: prepare.requestId,
    createRequestId: created.requestId,
    bindRequestId: binds[0].requestId,
    agentId: prepared.agentId,
    workspaceId: bound.workspaceId,
    promptSha256: createHash("sha256").update(repair.nativePrompt(prepared.agentId)!).digest("hex"),
    promptBytes: prepared.bytes,
    parentLabelAbsent: true,
  });
}

async function exerciseMixedApp(
  page: Page,
  repair: RepairDaemon,
  testInfo: TestInfo,
  pair: Exclude<RepairPair, "repair/repair">,
) {
  await page.setViewportSize({ width: 1280, height: 900 });
  expect(repair.mixed?.pair).toBe(pair);
  const mixed = repair.mixed!;
  await assertMixedProjectIsolation(page, repair, mixed, testInfo);
  if (pair === "current-app/old-core") {
    expect(
      mixed.rpc
        .filter((entry) => entry.board)
        .every((entry) => !entry.board!.keys.includes("teamScopes")),
    ).toBe(true);
    await openMixedProjects(page, repair);
    await openProjectSettings(page, repair.projectName);
    await expect(page).toHaveURL(buildProjectSettingsRoute(repair.serverId, repair.projectId));
    await page.getByTestId("project-pwa-edit").click();
    await expect(page.getByTestId("project-pwa-directory")).toHaveValue(repair.legacyRoot);
    await expect(page.getByTestId("project-pwa-default")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("mixed-old-host-path-only-settings.png") });
    await page
      .getByTestId("project-pwa-sheet")
      .getByRole("button", { name: "Close", exact: true })
      .filter({ hasText: /^Close$/ })
      .click();
    const reads = mixed.rpc.filter(
      (entry) =>
        entry.method === "swarm.pwa_source.read" &&
        entry.input.projectId === repair.projectId &&
        entry.source,
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const entry of reads)
      expect(entry.source).toEqual({ keys: ["path"], path: repair.legacyRoot });
    await returnMixedBoardFromSettings(page, repair);
  }
  await assertMixedLegacyWizard(page, repair, mixed, testInfo);
}

repairTest.describe("Swarm mixed old app/current core", () => {
  repairTest.use({ repairPair: "old-app/current-core" });
  repairTest(
    "Swarm mixed: old app preserves Project isolation and supervisor U/P/W on repaired core",
    async ({ page, repair }, testInfo) => {
      repairTest.setTimeout(210_000);
      await exerciseMixedApp(page, repair, testInfo, "old-app/current-core");
    },
  );
});

repairTest.describe("Swarm mixed current app/old core", () => {
  repairTest.use({ repairPair: "current-app/old-core" });
  repairTest(
    "Swarm mixed: repaired app preserves legacy Project and creation contracts on actual old core",
    async ({ page, repair }, testInfo) => {
      repairTest.setTimeout(210_000);
      await exerciseMixedApp(page, repair, testInfo, "current-app/old-core");
    },
  );
});

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
