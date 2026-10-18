import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";
import { pluginRequirements } from "../support/helpers/plugin-fixture";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Locator, TestInfo } from "@playwright/test";
import { expect, test, type Page } from "../support/fixtures";
import { gotoAppShell, openSettings } from "../support/helpers/app";
import { openSettingsSection } from "../support/helpers/settings";
import { openCommandCenter } from "../support/helpers/command-center";
import { submitMessage } from "../support/helpers/composer";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { buildAgentRoute } from "../support/helpers/mock-agent";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { expectMobileAgentSidebarHidden } from "../support/helpers/sidebar";
import {
  repairTest,
  openRepairBoard,
  chooseRepairScope,
  type RepairDaemon,
} from "../support/helpers/swarm-test-daemon";
import {
  switchWorkspaceViaSidebar,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

const PLUGIN_ID = "workspace-panel-e2e";
const WIDE_VIEWPORT = { width: 1280, height: 900 };
const COMPACT_VIEWPORT = { width: 390, height: 844 };

repairTest(
  "Swarm repair: full Project and supervisor scopes preserve workflow, records and own draft",
  async ({ page, repair }, testInfo) => {
    repairTest.setTimeout(210_000);
    await page.setViewportSize(WIDE_VIEWPORT);
    await openRepairBoard(page, repair);
    const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
    const visibleTask = (id: string) =>
      surface.getByTestId(`swarm-task-${id}`).filter({ visible: true });
    await chooseRepairScope(page, "Project");
    for (const id of ["qa-survey", "qa-completed", "qa-nested", "qa-queued", "qa-historical"]) {
      await expect(visibleTask(id)).toHaveCount(1);
    }
    await expect(visibleTask("qa-foreign")).toHaveCount(0);
    await expect(surface.getByText("Undeclared status · survey", { exact: true })).toHaveCount(0);
    await expect(surface.getByText("Undeclared status · completed", { exact: true })).toHaveCount(
      0,
    );
    await expect(surface.getByTestId("swarm-column-queued")).toBeVisible();
    await chooseRepairScope(page, "Supervisor · qa-planner.left");
    await expect(visibleTask("qa-survey")).toHaveCount(1);
    await expect(visibleTask("qa-nested")).toHaveCount(1);
    await expect(visibleTask("qa-completed")).toHaveCount(0);
    await surface.getByRole("button", { name: "Scope", exact: true }).click();
    for (const label of [
      "Project",
      "Planner · qa-other",
      "Supervisor · qa-planner.right",
      "Supervisor · qa-planner.left.nested",
    ]) {
      await expect(page.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
    }
    await expect(
      page.getByRole("menuitem", { name: "Planner · qa-planner-outsider", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("menuitem", { name: "Supervisor · qa-planner.right", exact: true })
      .click();
    await expect(visibleTask("qa-completed")).toHaveCount(1);
    await expect(visibleTask("qa-survey")).toHaveCount(0);
    await chooseRepairScope(page, "Planner · qa-other");
    await expect(visibleTask("qa-queued")).toHaveCount(1);
    await expect(visibleTask("qa-survey")).toHaveCount(0);
    await chooseRepairScope(page, "Unattributed Tasks");
    await visibleTask("qa-unavailable").click();
    await expect(surface.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "Retained Activity for qa-unavailable.",
    );
    await expect(surface.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "completed",
    );
    await surface.getByTestId("swarm-task-back").filter({ visible: true }).click();

    await chooseRepairScope(page, "Supervisor · qa-planner.left");
    await visibleTask("qa-survey").click();
    const detail = surface.getByTestId("swarm-task-detail").filter({ visible: true });
    const editor = detail.getByTestId("swarm-activity-input");
    await expect(editor).toHaveValue("");
    await expect(detail.getByRole("button", { name: "Cancel reply", exact: true })).toHaveCount(0);
    const ownDraft = "[swarm-repair-qa] retained unsent Activity";
    await editor.fill(ownDraft);
    const previousHandle = await editor.elementHandle();
    await detail.getByTestId("swarm-task-back").click();
    await chooseRepairScope(page, "Planner · qa-other");
    await expect(visibleTask("qa-queued")).toHaveCount(1);
    await chooseRepairScope(page, "Supervisor · qa-planner.left");
    await visibleTask("qa-survey").click();
    await expect(editor).toHaveValue(ownDraft);
    expect(await editor.evaluate((node, original) => node === original, previousHandle)).toBe(true);
    await editor.fill("");
    await detail.getByTestId("swarm-task-back").click();
    await chooseRepairScope(page, "Project");

    let lightBackground: string | undefined;
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const viewport of [WIDE_VIEWPORT, COMPACT_VIEWPORT]) {
        await page.setViewportSize(viewport);
        await expect(surface.getByRole("button", { name: "Scope", exact: true })).toBeVisible();
        const bounds = await surface.boundingBox();
        expect(bounds).not.toBeNull();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
        await expect(visibleTask("qa-survey")).toHaveCount(1);
        await page.screenshot({
          path: testInfo.outputPath(`swarm-repair-project-${viewport.width}-${scheme}.png`),
        });
      }
      const background = await surface.evaluate((node) => getComputedStyle(node).backgroundColor);
      if (scheme === "light") lightBackground = background;
      else
        await expect
          .poll(() => surface.evaluate((node) => getComputedStyle(node).backgroundColor))
          .not.toBe(lightBackground);
    }
    const legacyRequest = (await repair.invoke("swarm.board.read", {
      projectId: repair.projectId,
    })) as { tasks: Array<{ id: string }>; activities: Array<{ taskId: string }> };
    expect(legacyRequest.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining(["qa-survey", "qa-completed", "qa-queued", "qa-historical"]),
    );
    expect(legacyRequest.activities.map((activity) => activity.taskId)).toContain("qa-survey");
    await chooseRepairScope(page, "Supervisor · qa-planner.left");
    await visibleTask("qa-survey").click();
    await surface.getByRole("link", { name: "Alternate Task", exact: true }).click();
    await expect(page.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "QA alternate Task",
    );
    await expect(page.getByTestId("swarm-task-detail").filter({ visible: true })).toContainText(
      "qa-queued",
    );
  },
);

interface RepairMenuFrame {
  name: string;
  labels: string[];
  items: unknown[];
}

const REPAIR_SCOPE_LABELS = {
  en: [
    "Project",
    "Planner · qa-planner",
    "Supervisor · qa-planner.left",
    "Supervisor · qa-planner.right",
    "Supervisor · qa-planner.left.nested",
    "Planner · qa-other",
    "Unattributed Tasks",
  ],
  zh: [
    "项目",
    "规划者 · qa-planner",
    "主管 · qa-planner.left",
    "主管 · qa-planner.right",
    "主管 · qa-planner.left.nested",
    "规划者 · qa-other",
    "未归属 Tasks",
  ],
} as const;

async function closeRepairAcceptanceMenu(page: Page): Promise<void> {
  const backdrop = page
    .getByRole("button", {
      name: /^(Menu backdrop|菜单背景|Bottom sheet backdrop|底部面板背景)$/,
    })
    .filter({ visible: true });
  await expect(backdrop).toHaveCount(1);
  await backdrop.click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole("menuitem").filter({ visible: true })).toHaveCount(0);
}

async function recordRepairControlGeometry(control: Locator): Promise<unknown> {
  await control.scrollIntoViewIfNeeded();
  await expect(control).toBeVisible();
  const geometry = await control.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const clipped = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    const ancestors = [];
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const box = parent.getBoundingClientRect();
      const clipsX = /auto|scroll|hidden|clip/.test(style.overflowX);
      const clipsY = /auto|scroll|hidden|clip/.test(style.overflowY);
      if (clipsX) {
        clipped.left = Math.max(clipped.left, box.left);
        clipped.right = Math.min(clipped.right, box.right);
      }
      if (clipsY) {
        clipped.top = Math.max(clipped.top, box.top);
        clipped.bottom = Math.min(clipped.bottom, box.bottom);
      }
      if (clipsX || clipsY) ancestors.push({ rect: box.toJSON(), clipsX, clipsY });
    }
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const range = document.createRange();
    range.selectNodeContents(node);
    const text = range.getBoundingClientRect();
    return {
      rect: rect.toJSON(),
      clipped,
      ancestors,
      text: text.toJSON(),
      centerHitsControl: hit !== null && node.contains(hit),
    };
  });
  expect(geometry.rect.width).toBeGreaterThan(0);
  expect(geometry.rect.height).toBeGreaterThan(0);
  expect(geometry.rect.left).toBeGreaterThanOrEqual(geometry.clipped.left - 1);
  expect(geometry.rect.right).toBeLessThanOrEqual(geometry.clipped.right + 1);
  expect(geometry.rect.top).toBeGreaterThanOrEqual(geometry.clipped.top - 1);
  expect(geometry.rect.bottom).toBeLessThanOrEqual(geometry.clipped.bottom + 1);
  expect(geometry.text.width).toBeGreaterThan(0);
  expect(geometry.text.height).toBeGreaterThan(0);
  expect(geometry.text.left).toBeGreaterThanOrEqual(geometry.clipped.left - 1);
  expect(geometry.text.right).toBeLessThanOrEqual(geometry.clipped.right + 1);
  expect(geometry.text.top).toBeGreaterThanOrEqual(geometry.clipped.top - 1);
  expect(geometry.text.bottom).toBeLessThanOrEqual(geometry.clipped.bottom + 1);
  expect(geometry.centerHitsControl).toBe(true);
  return geometry;
}

async function captureRepairMenu(
  page: Page,
  testInfo: TestInfo,
  name: string,
  labels: readonly string[],
  selected: string,
): Promise<RepairMenuFrame> {
  await expect(page.getByRole("menuitem")).toHaveCount(labels.length);
  const items: unknown[] = [];
  for (const [index, label] of labels.entries()) {
    const item = page.getByRole("menuitem", { name: label, exact: true });
    await expect(item).toHaveAttribute("aria-checked", String(label === selected));
    items.push({ label, geometry: await recordRepairControlGeometry(item) });
    if (index === 0) await capture(page, testInfo, `${name}-first`);
    if (index === labels.length - 1) await capture(page, testInfo, `${name}-last`);
  }
  await closeRepairAcceptanceMenu(page);
  return { name, labels: [...labels], items };
}

async function chooseChineseRepairScope(page: Page, label: string): Promise<void> {
  const scope = page
    .getByTestId("swarm-task-surface")
    .filter({ visible: true })
    .getByRole("button", { name: "范围", exact: true });
  await scope.click();
  await page.getByRole("menuitem", { name: label, exact: true }).click();
  await expect(scope).toContainText(label);
}

async function chooseRepairStatus(page: Page, status: string): Promise<void> {
  const trigger = page.getByTestId("swarm-task-status-filter").filter({ visible: true });
  await trigger.click();
  await page.getByRole("menuitem", { name: status, exact: true }).click();
  await expect(page.getByRole("menuitem", { name: status, exact: true })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await closeRepairAcceptanceMenu(page);
  await expect(trigger).toHaveText(status);
}

async function expectRepairFilterTasks(page: Page, ids: readonly string[]): Promise<void> {
  const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
  for (const id of [
    "qa-survey",
    "qa-nested",
    "qa-completed",
    "qa-historical",
    "qa-queued",
    "qa-unavailable",
    "qa-foreign",
  ]) {
    await expect(surface.getByTestId(`swarm-task-${id}`).filter({ visible: true })).toHaveCount(
      ids.includes(id) ? 1 : 0,
    );
  }
}

async function chooseRepairTheme(page: Page, language: "en" | "zh", theme: string): Promise<void> {
  const prefix = language === "en" ? /^Theme: / : /^主题：/;
  const trigger = page.getByLabel(prefix);
  await trigger.click();
  await page.getByRole("menuitem", { name: theme, exact: true }).click();
  await expect(trigger).toHaveAttribute(
    "aria-label",
    `${language === "en" ? "Theme: " : "主题："}${theme}`,
  );
}

async function captureRepairOpenFilters(
  page: Page,
  testInfo: TestInfo,
  language: "en" | "zh",
  selectedStatus: string,
): Promise<RepairMenuFrame[]> {
  const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
  const labels = REPAIR_SCOPE_LABELS[language];
  const scope = surface.getByRole("button", {
    name: language === "en" ? "Scope" : "范围",
    exact: true,
  });
  const status = surface.getByTestId("swarm-task-status-filter");
  await recordRepairControlGeometry(scope);
  await recordRepairControlGeometry(status);
  const scopeBox = await scope.boundingBox();
  const statusBox = await status.boundingBox();
  expect(scopeBox).not.toBeNull();
  expect(statusBox).not.toBeNull();
  const overlapX =
    Math.min(scopeBox!.x + scopeBox!.width, statusBox!.x + statusBox!.width) -
    Math.max(scopeBox!.x, statusBox!.x);
  const overlapY =
    Math.min(scopeBox!.y + scopeBox!.height, statusBox!.y + statusBox!.height) -
    Math.max(scopeBox!.y, statusBox!.y);
  expect(overlapX <= 1 || overlapY <= 1).toBe(true);
  await scope.click();
  const scopeFrame = await captureRepairMenu(
    page,
    testInfo,
    `repair-${language}-scope`,
    labels,
    labels[1],
  );
  await status.click();
  const all = language === "en" ? "All statuses" : "全部状态";
  const statusFrame = await captureRepairMenu(
    page,
    testInfo,
    `repair-${language}-planner-status`,
    [all, "survey", "completed", "historic-review"],
    selectedStatus,
  );
  return [scopeFrame, statusFrame];
}

async function checkEnglishRepairFilters(
  page: Page,
  testInfo: TestInfo,
  frames: RepairMenuFrame[],
): Promise<void> {
  await chooseRepairScope(page, "Planner · qa-planner");
  await chooseRepairStatus(page, "survey");
  await expectRepairFilterTasks(page, ["qa-survey", "qa-nested"]);
  frames.push(...(await captureRepairOpenFilters(page, testInfo, "en", "survey")));
  await chooseRepairScope(page, "Planner · qa-other");
  const status = page.getByTestId("swarm-task-status-filter").filter({ visible: true });
  await expect(status).toHaveText("All statuses");
  await expectRepairFilterTasks(page, ["qa-queued"]);
  await chooseRepairStatus(page, "queued");
  await status.click();
  frames.push(
    await captureRepairMenu(
      page,
      testInfo,
      "repair-en-other-status",
      ["All statuses", "queued", "completed"],
      "queued",
    ),
  );
  await chooseRepairScope(page, "Planner · qa-planner");
  await expect(status).toHaveText("survey");
  await expectRepairFilterTasks(page, ["qa-survey", "qa-nested"]);
  await chooseRepairScope(page, "Planner · qa-other");
  await expect(status).toHaveText("queued");
  await expectRepairFilterTasks(page, ["qa-queued"]);
  await chooseRepairScope(page, "Planner · qa-planner");
  await chooseRepairStatus(page, "All statuses");
  await expectRepairFilterTasks(page, ["qa-survey", "qa-nested", "qa-completed", "qa-historical"]);
  await chooseRepairScope(page, "Planner · qa-other");
  await chooseRepairStatus(page, "All statuses");
  await expectRepairFilterTasks(page, ["qa-queued"]);
}

async function checkChineseRepairFilters(
  page: Page,
  testInfo: TestInfo,
  frames: RepairMenuFrame[],
  lightBackground: string,
): Promise<void> {
  const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
  const status = page.getByTestId("swarm-task-status-filter").filter({ visible: true });
  await chooseChineseRepairScope(page, "规划者 · qa-planner");
  await page.setViewportSize(COMPACT_VIEWPORT);
  await expect(status).toHaveText("全部状态");
  await expect
    .poll(() => surface.evaluate((node) => getComputedStyle(node).backgroundColor))
    .not.toBe(lightBackground);
  frames.push(...(await captureRepairOpenFilters(page, testInfo, "zh", "全部状态")));
  await chooseChineseRepairScope(page, "规划者 · qa-other");
  await expect(status).toHaveText("全部状态");
  await status.click();
  frames.push(
    await captureRepairMenu(
      page,
      testInfo,
      "repair-zh-other-status",
      ["全部状态", "queued", "completed"],
      "全部状态",
    ),
  );
  await expectRepairFilterTasks(page, ["qa-queued"]);
}

async function returnRepairBoardFromSettings(
  page: Page,
  repair: RepairDaemon,
  label: "Back" | "返回",
): Promise<void> {
  const back = page
    .getByRole("button", { name: label, exact: true })
    .and(page.getByTestId("settings-back-to-workspace"))
    .filter({ visible: true });
  await expect(back).toHaveCount(1);
  await expect(back).toBeVisible();
  await expect(back).toBeEnabled();
  await back.click();
  await expect(page).toHaveURL(buildHostWorkspaceRoute(repair.serverId, repair.workspaceId));
  await expect(page.getByTestId("swarm-task-surface").filter({ visible: true })).toHaveCount(1);
}

async function checkRepairOpenControls(
  page: Page,
  repair: RepairDaemon,
  testInfo: TestInfo,
  language: "en" | "zh",
): Promise<void> {
  const frames: RepairMenuFrame[] = [];
  let originalLanguage: string | null = null;
  let originalTheme: string | null = null;
  let chinese = false;
  let failed = false;
  let failure: unknown;
  const restorationErrors: unknown[] = [];
  try {
    await page.setViewportSize(WIDE_VIEWPORT);
    await openRepairBoard(page, repair);
    await openSettings(page);
    await openSettingsSection(page, "general");
    const languageControl = page.getByRole("button", { name: /^(System|English)$/ });
    await expect(languageControl).toHaveCount(1);
    originalLanguage = await languageControl.getAttribute("aria-label");
    expect(["System", "English"]).toContain(originalLanguage);
    await page.getByRole("button", { name: originalLanguage!, exact: true }).click();
    await page.getByRole("menuitem", { name: "English", exact: true }).click();
    await expect(page.getByRole("button", { name: "English", exact: true })).toBeVisible();
    await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
    await openSettingsSection(page, "appearance");
    originalTheme = (await page.getByLabel(/^Theme: /).getAttribute("aria-label"))!.slice(
      "Theme: ".length,
    );
    expect([
      "System",
      "Light",
      "Dark",
      "Zinc",
      "Midnight",
      "Claude",
      "Ghostty",
      "Pure black",
    ]).toContain(originalTheme);
    await chooseRepairTheme(page, "en", "Light");
    if (language === "en") {
      await openRepairBoard(page, repair);
      await checkEnglishRepairFilters(page, testInfo, frames);
    } else {
      await returnRepairBoardFromSettings(page, repair, "Back");
      const surface = page.getByTestId("swarm-task-surface").filter({ visible: true });
      const lightBackground = await surface.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      await openSettings(page);
      await openSettingsSection(page, "general");
      await page.getByRole("button", { name: "English", exact: true }).click();
      await page
        .getByRole("menuitem", { name: "简体中文 - Simplified Chinese", exact: true })
        .click();
      chinese = true;
      await expect(page.getByText("默认发送", { exact: true }).first()).toBeVisible();
      await expect(page.getByRole("button", { name: "简体中文", exact: true })).toBeVisible();
      await page
        .getByTestId("settings-sidebar")
        .getByRole("button", { name: "外观", exact: true })
        .click();
      await chooseRepairTheme(page, "zh", "Dark");
      await returnRepairBoardFromSettings(page, repair, "返回");
      await checkChineseRepairFilters(page, testInfo, frames, lightBackground);
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    try {
      await page.setViewportSize(WIDE_VIEWPORT);
      if (await page.getByRole("menuitem").filter({ visible: true }).count())
        await closeRepairAcceptanceMenu(page);
      await openSettings(page);
      if (chinese) {
        await page
          .getByTestId("settings-sidebar")
          .getByRole("button", { name: "通用", exact: true })
          .click();
        await page.getByRole("button", { name: "简体中文", exact: true }).click();
        await page
          .getByRole("menuitem", {
            name: originalLanguage === "System" ? "系统" : "English - 英语",
            exact: true,
          })
          .click();
        await expect(page.getByText("Default send", { exact: true }).first()).toBeVisible();
      }
      if (originalLanguage !== null) {
        await openSettingsSection(page, "general");
        if (!chinese) {
          await page.getByRole("button", { name: "English", exact: true }).click();
          await page.getByRole("menuitem", { name: originalLanguage, exact: true }).click();
        }
        await expect(
          page.getByRole("button", { name: originalLanguage, exact: true }),
        ).toBeVisible();
      }
    } catch (error) {
      restorationErrors.push(error);
    }
    try {
      if (originalTheme !== null) {
        await openSettingsSection(page, "appearance");
        await chooseRepairTheme(page, "en", originalTheme);
      }
    } catch (error) {
      restorationErrors.push(error);
    }
    try {
      await testInfo.attach("swarm-repair-open-controls", {
        body: JSON.stringify(
          {
            originalLanguage,
            originalTheme,
            frames,
            restorationErrorCount: restorationErrors.length,
          },
          null,
          2,
        ),
        contentType: "application/json",
      });
    } catch (error) {
      restorationErrors.push(error);
    }
  }
  if (failed) throw failure;
  if (restorationErrors.length)
    throw new AggregateError(restorationErrors, "Original language/theme restoration failed");
}

repairTest(
  "Swarm repair: independent planner status filters and open controls in English light at 1280",
  async ({ page, repair }, testInfo) => {
    repairTest.setTimeout(210_000);
    await checkRepairOpenControls(page, repair, testInfo, "en");
  },
);

repairTest(
  "Swarm repair: independent open planner controls in Chinese dark at 390",
  async ({ page, repair }, testInfo) => {
    repairTest.setTimeout(210_000);
    await checkRepairOpenControls(page, repair, testInfo, "zh");
  },
);

function isSettledWorkspaceUrl(url: URL): boolean {
  return url.pathname.includes("/workspace/") && !url.searchParams.has("open");
}

function pluginClientSource(input: {
  workspaceId: string;
  agentId: string;
  remoteServerId: string;
  remoteWorkspaceId: string;
  remoteAgentId: string;
}): string {
  return `import React, { useRef } from "react";
import { Pressable, Text, View } from "react-native";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useAgent, useWorkspace, openExternalUrl } from "@getpaseo/plugin/client";
import { ExternalLink } from "@getpaseo/plugin/client/ui";
import { recordComposerOpen } from "./shared/rpc";

function WorkspacePanel({ workspaceId, host, layout }) {
  const workspace = useWorkspace(workspaceId, (value) => ({ id: value.id }));
  const renderCount = useRef(0);
  renderCount.current += 1;
  return <View><Text>Workspace bridge {workspace?.id}</Text><Text>Workspace renders {renderCount.current}</Text><Text>Host {host.id}</Text><Text>Layout {layout.compact ? "compact" : "wide"}</Text></View>;
}

function AgentPanel({ workspaceId, agentId, host, layout }) {
  const workspace = useWorkspace(workspaceId, (value) => ({ id: value.id }));
  const agent = useAgent(agentId, (value) => ({ id: value.id }));
  return <View><Text>Agent bridge {agent?.id}</Text><Text>Workspace {workspace?.id}</Text><Text>Host {host.id}</Text><Text>Layout {layout.compact ? "compact" : "wide"}</Text></View>;
}

function DirectCollisionSurface({ navigation }) {
  return <View>
    <Text>Direct collision surface</Text>
    <Text>{navigation.openBrowser ? "Browser available" : "Browser unavailable"}</Text>
    <ExternalLink href="https://example.com/">Plugin documentation</ExternalLink>
    <Pressable accessibilityRole="button" onPress={() => openExternalUrl("https://example.com/")}><Text>Open external plugin URL</Text></Pressable>
    {navigation ? <>
      <Pressable accessibilityRole="button" onPress={() => navigation.openWorkspace({ workspaceId: ${JSON.stringify(input.workspaceId)} })}><Text>Open workspace from plugin</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: ${JSON.stringify(input.agentId)} })}><Text>Open agent from plugin</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.openWorkspace({ serverId: ${JSON.stringify(input.remoteServerId)}, workspaceId: ${JSON.stringify(input.remoteWorkspaceId)} })}><Text>Open remote workspace from plugin</Text></Pressable>
      <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ serverId: ${JSON.stringify(input.remoteServerId)}, agentId: ${JSON.stringify(input.remoteAgentId)} })}><Text>Open remote agent from plugin</Text></Pressable>
    </> : null}
  </View>;
}

function SidebarCollisionSurface() {
  return <View><Text>Sidebar collision surface</Text></View>;
}

function contributeClient(client) {
  const pills = new Map();
  const remove = (agentId) => {
    pills.get(agentId)?.();
    pills.delete(agentId);
  };
  const apply = (update) => {
    if (update.kind === "remove") {
      remove(update.agentId);
      return;
    }
    const agent = update.agent;
    if (agent.title !== "Plugin panel context agent" || !agent.workspaceId) return;
    remove(agent.id);
    const pill = client.addComposerPill({
      id: "review",
      workspaceId: agent.workspaceId,
      agentId: agent.id,
      button: {
        title: "Open composer review",
        icon: "Scan",
        label: "Review",
        behavior: { kind: "action", async onPress() {
        await client.rpc(recordComposerOpen, { workspaceId: agent.workspaceId });
        pill.remove();
        client.openPanel("agent", {
          workspaceId: agent.workspaceId,
          agentId: agent.id,
        });
        } },
      },
    });
    pills.set(agent.id, () => pill.remove());
  };
  const lifetime = new AbortController();
  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    subscription.subscribe({
      snapshot({ entries }) {
        for (const removePill of pills.values()) removePill();
        pills.clear();
        for (const { agent } of entries) apply({ kind: "upsert", agent });
      },
      update(message) { if (message.type === "agent_update") apply(message.payload); },
    });
  }).catch((error) => { if (!lifetime.signal.aborted) console.error(error); });
  return () => {
    lifetime.abort();
    for (const removePill of pills.values()) removePill();
    pills.clear();
  };
}

export default function contribute(client) {
  client.addSurface("collision", DirectCollisionSurface);
  client.addSurface("sidebar-destination", SidebarCollisionSurface);
  client.addSidebarItem({ id: "collision", title: "Collision sidebar", icon: "Blocks", surface: "sidebar-destination" });
  client.addWorkspacePanel({ id: "workspace", title: "Workspace inspector", icon: "PanelsTopLeft", context: "workspace", Component: WorkspacePanel });
  client.addWorkspacePanel({ id: "agent", title: "Agent inspector", icon: "PanelTop", context: "agent", Component: AgentPanel });
  client.addCommandCenterItem({ id: "global", title: "Plugin global action", icon: "Blocks", context: "global", onSelect() {} });
  client.addCommandCenterItem({ id: "surface", title: "Open direct collision surface", icon: "Blocks", context: "workspace", onSelect({ openSurface }) { openSurface("collision"); } });
  client.addCommandCenterItem({ id: "workspace", title: "Open plugin workspace", icon: "PanelsTopLeft", context: "workspace", onSelect({ openPanel }) { openPanel("workspace"); } });
  client.addCommandCenterItem({ id: "agent", title: "Open plugin agent", icon: "PanelTop", context: "agent", onSelect({ openPanel }) { openPanel("agent"); } });
  return contributeClient(client);
}`;
}

const pluginSharedSource = `import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const recordComposerOpen = defineRpc({
  name: "composer.open",
  input: z.object({ workspaceId: z.string() }),
  output: z.object({ opened: z.boolean() }),
});`;

const pluginServerSource = `import { recordComposerOpen } from "./shared/rpc";

export default function contribute(server) {
  server.handle(recordComposerOpen, async ({ workspaceId }, { paseo }) => {
    await paseo.workspaces.ref(workspaceId).setTitle("Opened from composer pill");
    return { opened: true };
  });
  return () => {};
}`;

async function writePluginSources(
  directory: string,
  input: {
    workspaceId: string;
    agentId: string;
    remoteServerId: string;
    remoteWorkspaceId: string;
    remoteAgentId: string;
  },
): Promise<void> {
  await mkdir(path.join(directory, "shared"), { recursive: true });
  await Promise.all([
    writeFile(path.join(directory, "index.client.tsx"), pluginClientSource(input)),
    writeFile(path.join(directory, "index.server.ts"), pluginServerSource),
    writeFile(path.join(directory, "shared", "rpc.ts"), pluginSharedSource),
  ]);
}

async function searchCommands(page: Page, query: string) {
  const panel = await openCommandCenter(page);
  await panel.getByTestId("command-center-input").fill(query);
  return panel;
}

async function expectCommandAvailable(page: Page, title: string): Promise<void> {
  const panel = await searchCommands(page, title);
  await expect(panel.getByRole("button", { name: title, exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

async function expectCommandUnavailable(page: Page, title: string): Promise<void> {
  const panel = await searchCommands(page, title);
  await expect(panel.getByRole("button", { name: title, exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
}

async function runCommand(page: Page, title: string): Promise<void> {
  const panel = await searchCommands(page, title);
  await panel.getByRole("button", { name: title, exact: true }).click();
  await expect(panel).not.toBeVisible();
}

async function openPluginExternalTab(page: Page, role: "link" | "button", name: string) {
  const opened = page.context().waitForEvent("page");
  await page.getByRole(role, { name, exact: true }).click();
  const tab = await opened;
  await tab.waitForURL("https://example.com/");
  await tab.close();
}

interface RemoteNavigationTarget {
  serverId: string;
  workspaceId: string;
  agentId: string;
}

function remoteWorkspaceRoute(target: RemoteNavigationTarget): RegExp {
  return new RegExp(
    `/h/${encodeURIComponent(target.serverId)}/workspace/${encodeURIComponent(target.workspaceId)}(?:\\?.*)?$`,
  );
}

async function openRemoteWorkspaceFromPlugin(
  page: Page,
  target: RemoteNavigationTarget,
): Promise<void> {
  await page
    .getByRole("button", { name: "Open remote workspace from plugin", exact: true })
    .click();
  await page.waitForURL(remoteWorkspaceRoute(target));
  await expect(
    page
      .getByTestId(`workspace-deck-entry-${target.serverId}:${target.workspaceId}`)
      .getByTestId("workspace-header-title"),
  ).toBeVisible();
}

async function openRemoteAgentFromPlugin(
  page: Page,
  target: RemoteNavigationTarget,
): Promise<void> {
  await page.getByRole("button", { name: "Open remote agent from plugin", exact: true }).click();
  await page.waitForURL(remoteWorkspaceRoute(target));
  await expect(
    page.getByTestId(`workspace-tab-agent_${target.agentId}`).filter({ visible: true }).first(),
  ).toBeVisible();
}

async function openCompactSidebar(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open menu", exact: true }).click();
  await expect(page.getByTestId("sidebar-search")).toBeVisible();
}

async function capture(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: "image/png" });
}

test.describe("plugin workspace panels and Command Center", () => {
  test.describe.configure({ timeout: 240_000 });

  test("follows workspace, agent, host, compact, and unavailable state", async ({
    page,
  }, testInfo) => {
    const directory = await mkdtemp(path.join(tmpdir(), "paseo-plugin-workspace-panel-e2e-"));
    const primaryClient = await connectNewWorkspaceDaemonClient({ ownProjects: false });
    const previousConfig = await primaryClient.getDaemonConfig();
    const primary = await seedWorkspace({ repoPrefix: "plugin-panel-primary-" });
    const secondaryDaemon = await startIsolatedHostDaemon("plugin-panel-secondary");
    const secondary = await seedWorkspace({
      repoPrefix: "plugin-panel-secondary-",
      port: secondaryDaemon.port,
    });
    const secondaryAgent = await secondary.client.createAgent({
      provider: "mock",
      cwd: secondary.repoPath,
      workspaceId: secondary.workspaceId,
      title: "Remote plugin navigation agent",
      model: "ten-second-stream",
      modeId: "load-test",
    });
    await writeFile(
      path.join(directory, "paseo-plugin.json"),
      JSON.stringify({ id: PLUGIN_ID, requirements: pluginRequirements }),
    );
    await writePluginSources(directory, {
      workspaceId: primary.workspaceId,
      agentId: "missing-agent",
      remoteServerId: secondaryDaemon.serverId,
      remoteWorkspaceId: secondary.workspaceId,
      remoteAgentId: secondaryAgent.id,
    });

    try {
      await primaryClient.patchDaemonConfig({ pluginsEnabled: true });
      await primaryClient.installDirectoryPlugin(directory);
      await page.setViewportSize(WIDE_VIEWPORT);
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: secondaryDaemon.serverId,
        label: "Secondary plugin host",
        port: secondaryDaemon.port,
        primaryLabel: "Primary plugin host",
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: getServerId(),
        workspaceId: primary.workspaceId,
      });
      await waitForWorkspaceInSidebar(page, {
        serverId: secondaryDaemon.serverId,
        workspaceId: secondary.workspaceId,
      });

      await test.step("workspace context opens the real wide panel bridge", async () => {
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: primary.workspaceId,
        });
        await expectCommandAvailable(page, "Plugin global action");
        await expectCommandAvailable(page, "Open plugin workspace");
        await expectCommandUnavailable(page, "Open plugin agent");
        await runCommand(page, "Open plugin workspace");
        await expect(page.getByText(`Workspace bridge ${primary.workspaceId}`)).toBeVisible();
        const renderCount = Number(
          (await page.getByText(/Workspace renders \d+/).textContent())?.split(" ").at(-1),
        );
        await primaryClient.setWorkspaceTitle(primary.workspaceId, "Unrelated title update");
        await expect(page.getByTestId("workspace-header-title")).toHaveText(
          "Unrelated title update",
        );
        expect(
          Number((await page.getByText(/Workspace renders \d+/).textContent())?.split(" ").at(-1)),
        ).toBe(renderCount);
        await expect(page.getByText(`Host ${getServerId()}`, { exact: true })).toBeVisible();
        await expect(page.getByText("Layout wide", { exact: true })).toBeVisible();
        await capture(page, testInfo, "plugin-workspace-panel-wide");
      });

      await test.step("plugin links open browser tabs and in-app browsing is unavailable", async () => {
        await runCommand(page, "Open direct collision surface");
        await expect(page.getByText("Browser unavailable", { exact: true })).toBeVisible();
        await openPluginExternalTab(page, "link", "Plugin documentation");
        await openPluginExternalTab(page, "button", "Open external plugin URL");
        await capture(page, testInfo, "plugin-external-links-web");
        await page.getByTestId("plugin-surface-close").click();
      });

      await test.step("direct and sidebar routes preserve same-id contribution kind", async () => {
        await runCommand(page, "Open direct collision surface");
        await expect(page.getByText("Direct collision surface", { exact: true })).toBeVisible();
        await expect(page.getByText("Sidebar collision surface", { exact: true })).toHaveCount(0);
        await page.getByTestId("plugin-surface-close").click();

        await page.getByTestId(`plugin-sidebar-${PLUGIN_ID}-collision`).click();
        await expect(page.getByText("Sidebar collision surface", { exact: true })).toBeVisible();
        await expect(page.getByText("Direct collision surface", { exact: true })).toHaveCount(0);
        await capture(page, testInfo, "plugin-surface-kind-collision");
        await page.getByTestId("plugin-surface-close").click();
      });

      await test.step("surface navigation opens host-owned workspace and agent routes", async () => {
        await runCommand(page, "Open direct collision surface");
        await page.getByRole("button", { name: "Open workspace from plugin", exact: true }).click();
        await page.waitForURL(isSettledWorkspaceUrl);
        await expect(page.getByTestId("workspace-header-title")).toBeVisible();

        const agent = await primary.client.createAgent({
          provider: "mock",
          cwd: primary.repoPath,
          workspaceId: primary.workspaceId,
          title: "Plugin navigation agent",
          model: "ten-second-stream",
          modeId: "load-test",
        });
        const navigationAgentId = agent.id;
        await writePluginSources(directory, {
          workspaceId: primary.workspaceId,
          agentId: navigationAgentId,
          remoteServerId: secondaryDaemon.serverId,
          remoteWorkspaceId: secondary.workspaceId,
          remoteAgentId: secondaryAgent.id,
        });
        await primaryClient.reloadPlugin(PLUGIN_ID);

        await runCommand(page, "Open direct collision surface");
        await page.getByRole("button", { name: "Open agent from plugin", exact: true }).click();
        await page.waitForURL(isSettledWorkspaceUrl);
        await expect(
          page
            .getByTestId(`workspace-tab-agent_${navigationAgentId}`)
            .filter({ visible: true })
            .first(),
        ).toBeVisible();
      });

      await test.step("surface navigation opens a workspace and agent on another host", async () => {
        const remoteTarget = {
          serverId: secondaryDaemon.serverId,
          workspaceId: secondary.workspaceId,
          agentId: secondaryAgent.id,
        };
        await runCommand(page, "Open direct collision surface");
        await openRemoteWorkspaceFromPlugin(page, remoteTarget);
        await switchWorkspaceViaSidebar({
          page,
          serverId: getServerId(),
          workspaceId: primary.workspaceId,
        });
        await runCommand(page, "Open direct collision surface");
        await openRemoteAgentFromPlugin(page, remoteTarget);
      });

      await test.step("switching hosts removes commands from an uninstalled host", async () => {
        await switchWorkspaceViaSidebar({
          page,
          serverId: secondaryDaemon.serverId,
          workspaceId: secondary.workspaceId,
        });
        await expectCommandUnavailable(page, "Plugin global action");
        await expectCommandUnavailable(page, "Open plugin workspace");
      });

      await test.step("legacy sidebar URLs survive a full browser navigation", async () => {
        await page.goto(`/h/${encodeURIComponent(getServerId())}/plugin/${PLUGIN_ID}/collision`);
        await page.waitForURL(new RegExp(`/plugin/${PLUGIN_ID}/sidebar/collision(?:\\?.*)?$`));
        await expect(page.getByText("Sidebar collision surface", { exact: true })).toBeVisible();
      });

      await test.step("agent context opens the compact panel with synchronous snapshots", async () => {
        const agent = await primary.client.createAgent({
          provider: "mock",
          cwd: primary.repoPath,
          workspaceId: primary.workspaceId,
          title: "Plugin panel context agent",
          model: "ten-second-stream",
          modeId: "load-test",
        });
        await page.goto(buildAgentRoute(primary.workspaceId, agent.id));
        await page.waitForURL(isSettledWorkspaceUrl, { timeout: 60_000 });
        await submitMessage(page, "emit 1 agent stream updates");
        await expect(page.getByRole("button", { name: "1/1 tasks" })).toBeVisible({
          timeout: 30_000,
        });
        const composerPill = page.getByRole("button", { name: "Open composer review" });
        await expect(composerPill).toContainText("Review");
        await capture(page, testInfo, "plugin-composer-pill-wide");
        await page.setViewportSize(COMPACT_VIEWPORT);
        await expect(page.getByRole("button", { name: "Open composer review" })).toBeVisible();
        await capture(page, testInfo, "plugin-composer-pill-compact");
        await page.getByRole("button", { name: "Open composer review" }).click();
        await expect(page.getByTestId("workspace-header-title")).toHaveText(
          "Opened from composer pill",
        );
        await expect(page.getByText(`Agent bridge ${agent.id}`)).toBeVisible();
        await expect(page.getByText("Layout compact", { exact: true })).toBeVisible();
        await capture(page, testInfo, "plugin-agent-panel-compact");

        await page.goto(buildAgentRoute(primary.workspaceId, agent.id));
        await page.waitForURL(isSettledWorkspaceUrl, { timeout: 60_000 });
        // Pressing removed the pill from that page only. The reloaded page evaluates
        // the plugin again, and its agents snapshot contributes the pill afresh.
        await expect(page.getByRole("button", { name: "Open composer review" })).toBeVisible();
        await openCompactSidebar(page);
        // The sidebar's Search row dismisses the compact sidebar on its way to the
        // command center, so nothing has to close it after the command runs.
        await runCommand(page, "Open plugin agent");
        await expectMobileAgentSidebarHidden(page);
        await expect(page.getByText(`Agent bridge ${agent.id}`)).toBeVisible();
        await expect(
          page.getByText(`Workspace ${primary.workspaceId}`, { exact: true }),
        ).toBeVisible();
        await expect(page.getByText(`Host ${getServerId()}`, { exact: true })).toBeVisible();
        await expect(page.getByText("Layout compact", { exact: true })).toBeVisible();
      });

      await test.step("removing the active plugin renders the panel unavailable", async () => {
        await primaryClient.removePlugin(PLUGIN_ID);
        await expect(
          page.getByText("This plugin panel is unavailable.", { exact: true }),
        ).toBeVisible({
          timeout: 30_000,
        });
        await capture(page, testInfo, "plugin-panel-unavailable");
        await openCompactSidebar(page);
        await expectCommandUnavailable(page, "Open plugin agent");
      });
    } finally {
      await primaryClient.removePlugin(PLUGIN_ID).catch(() => undefined);
      await primaryClient
        .patchDaemonConfig({ pluginsEnabled: previousConfig.config.pluginsEnabled ?? false })
        .catch(() => undefined);
      await primaryClient.close().catch(() => undefined);
      await primary.cleanup().catch(() => undefined);
      await secondary.cleanup().catch(() => undefined);
      await secondaryDaemon.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  });
});
