import { execSync } from "node:child_process";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { openAgentRoute } from "../support/helpers/mock-agent";
import { seedWorkspace } from "../support/helpers/seed-client";
import { ensureExplorerSidebar } from "../support/helpers/workspace-tabs";

// A Swarm seat running real git commands through a scripted ACP agent. The Needs you
// inbox holds the push until a human answers it in the Tasks surface.
test.skip(process.platform === "win32", "Swarm approval shims are POSIX shell scripts.");
test.use({
  e2eDaemonConfig: {
    version: 1,
    agents: {
      providers: {
        "shell-acp": {
          extends: "acp",
          label: "Shell ACP",
          command: [process.execPath, path.resolve("e2e/fixtures/shell-acp.mjs")],
        },
      },
    },
  },
});

interface SwarmClient {
  connect(): Promise<void>;
  close(): Promise<void>;
  invokePluginRpc(pluginId: string, method: string, input: unknown): Promise<unknown>;
  waitForFinish(agentId: string, timeoutMs: number): Promise<unknown>;
}

interface Seat {
  swarmId: string;
  paseoAgentId: string | null;
  workspaceId: string | null;
}

const swarm = (client: SwarmClient, method: string, input: unknown) =>
  client.invokePluginRpc("paseo-swarm", method, input);

// A planner seat in a swarm made from the bundled PR workflow. Its first mail starts its agent
// at the project root, so its pushes land in the seeded repo's remote.
async function seedSwarmSeat() {
  // Swarm state lives for the worker's daemon, so each test (and retry) gets its own seat.
  const name = `lead-${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `${name}-task`;
  const workspace = await seedWorkspace({ repoPrefix: "swarm-gate-", repo: { withRemote: true } });
  const client = await connectDaemonClient<SwarmClient>({ clientIdPrefix: "swarm-needs-you" });
  await swarm(client, "swarm.pwa_source.set", {
    projectId: workspace.projectId,
    path: path.resolve("../../plugins/paseo-swarm/pwa/pr-workflow"),
  });
  const { swarmId } = (await swarm(client, "swarm.seat.create", {
    projectId: workspace.projectId,
    name,
    roleClass: "planner",
    role: "planner",
    provider: "shell-acp/shell",
  })) as Seat;
  await swarm(client, "swarm.task.create", {
    swarmId,
    id: taskId,
    title: "Ship it",
    brief: "Push the release commit.",
    status: "development",
    managerName: name,
    createdBy: name,
  });
  // The scripted agent runs the body of each mail it gets as a shell command.
  const run = async (command: string) => {
    await swarm(client, "swarm.message.send", {
      swarmId,
      senderName: "human",
      recipientName: name,
      body: command,
    });
    const seat = (await swarm(client, "swarm.seat.list", { swarmId })) as { seats: Seat[] };
    const placed = seat.seats.find((candidate) => candidate.paseoAgentId);
    if (!placed?.paseoAgentId || !placed.workspaceId) throw new Error(`${name} has no agent`);
    return { agentId: placed.paseoAgentId, workspaceId: placed.workspaceId };
  };
  // Start the seat's agent, so the tests can open its workspace.
  const started = await run("true");
  await client.waitForFinish(started.agentId, 60_000);
  return {
    ...workspace,
    ...started,
    name,
    taskId,
    swarmId,
    run,
    finish: () => client.waitForFinish(started.agentId, 60_000),
    swarm: (method: string, input: unknown) => swarm(client, method, input),
    remoteLog: () =>
      execSync("git --git-dir remote.git log --format=%s main", {
        cwd: workspace.repoPath,
      }).toString(),
    cleanup: async () => {
      await client.close().catch(() => undefined);
      await workspace.cleanup();
    },
  };
}

async function openNeedsYou(page: Page, workspaceId: string, agentId: string) {
  await openAgentRoute(page, { workspaceId, agentId });
  const explorer = await ensureExplorerSidebar(page);
  await explorer.getByTestId("workspace-new-tab-button").click();
  await page.getByTestId("workspace-new-tab-menu-tasks").filter({ visible: true }).click();
  const inbox = page.getByTestId("swarm-needs-you").filter({ visible: true });
  await expect(inbox).toBeVisible({ timeout: 30_000 });
  return inbox;
}

test("Needs you holds a seat's push until a human approves or denies it", async ({
  page,
}, testInfo) => {
  const member = await seedSwarmSeat();
  try {
    await member.run('git commit --allow-empty -qm "release" && git push -q origin HEAD:main');
    const inbox = await openNeedsYou(page, member.workspaceId, member.agentId);
    const approval = inbox.locator('[data-testid^="swarm-inbox-"]').filter({
      hasText: "git push -q origin HEAD:main",
    });
    await expect(approval).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText(`Push commits (${member.name})`);
    await page.screenshot({ path: testInfo.outputPath("needs-you-approval.png") });
    expect(member.remoteLog()).not.toContain("release");

    await approval.getByRole("button", { name: "Approve" }).click();
    await member.finish();
    expect(member.remoteLog()).toContain("release");
    await expect(approval).toHaveCount(0);

    await member.run('git commit --allow-empty -qm "hotfix" && git push -q origin HEAD:main');
    const second = inbox.locator('[data-testid^="swarm-inbox-"]').filter({
      hasText: "git push -q origin HEAD:main",
    });
    await expect(second).toBeVisible({ timeout: 30_000 });
    await second.getByRole("button", { name: "Deny" }).click();
    await member.finish();
    expect(member.remoteLog()).not.toContain("hotfix");
    await expect(page.getByTestId("assistant-message").last()).toContainText(
      "A human denied git push",
    );
  } finally {
    await member.cleanup();
  }
});

test("Needs you answers a choice inline and shows its default", async ({ page }, testInfo) => {
  const member = await seedSwarmSeat();
  try {
    await member.swarm("swarm.activity.append", {
      swarmId: member.swarmId,
      taskId: member.taskId,
      actorName: member.name,
      kind: "question",
      body: "Which release channel?",
      data: {
        action: {
          type: "choice",
          prompt: "Which release channel?",
          options: [
            { id: "beta", label: "Beta" },
            { id: "stable", label: "Stable" },
          ],
          defaultOptionId: "beta",
          timeoutMinutes: 30,
        },
      },
    });
    const inbox = await openNeedsYou(page, member.workspaceId, member.agentId);
    const choice = inbox
      .locator('[data-testid^="swarm-inbox-"]')
      .filter({ hasText: "Which release channel?" });
    await expect(choice).toContainText("Defaults to Beta at");
    await page.screenshot({ path: testInfo.outputPath("needs-you-choice.png") });

    await choice.getByRole("button", { name: "Stable" }).click();
    await expect(choice).toHaveCount(0);
  } finally {
    await member.cleanup();
  }
});
