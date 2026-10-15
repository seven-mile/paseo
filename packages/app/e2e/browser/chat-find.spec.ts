import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as envelopeTest, type ConsoleMessage, type TestInfo } from "@playwright/test";
import type { UserMessageFixtureBridge } from "../support/user-message.fixture";
import { expect, test, type Page } from "../support/fixtures";
import {
  openAgentRoute,
  seedMockAgentWorkspace,
  type MockAgentWorkspace,
} from "../support/helpers/mock-agent";
import { installDaemonWebSocketGate } from "../support/helpers/daemon-websocket-gate";
import {
  expectReconnectingToastGone,
  expectReconnectingToastVisible,
} from "../support/helpers/workspace-ui";
import { trackPromptJumpRequests } from "../support/helpers/agent-timeline-gate";
import {
  composerLocator,
  fillComposerDraft,
  expectComposerDraft,
  expectComposerFocused,
} from "../support/helpers/composer";

import { openCommandCenter, closeCommandCenter } from "../support/helpers/command-center";

const MAC_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const FILLER = Array.from({ length: 400 }, (_, index) => `filler${index}`).join(" ");
const STREAMED_RESPONSE = [
  "First paragraph with alpha-needle and pair-needle inside.",
  "Second paragraph with beta-needle and pair-needle inside.",
  `Third paragraph ${FILLER}`,
].join("\n\n");

const RESPONSE =
  'İ😀hello **world**; hello *world*.\n\n[hello &amp; world](https://example.com/hidden-destination)\n\n```ts\nconst a = "a.b";\n```\n\n- first cell\n- second cell';

// One message far taller than the viewport, so its first and last paragraph rows are
// never in the virtualizer's window at the same time.
const PARAGRAPH_PADDING = Array.from({ length: 40 }, (_, index) => `padding${index}`).join(" ");
const TALL_RESPONSE = Array.from({ length: 30 }, (_, index) => {
  if (index === 0) return `Opening paragraph with span-needle. ${PARAGRAPH_PADDING}`;
  if (index === 29) return `Closing paragraph with span-needle. ${PARAGRAPH_PADDING}`;
  return `Paragraph ${index}. ${PARAGRAPH_PADDING}`;
}).join("\n\n");

function query(page: Page) {
  return page.getByRole("textbox", { name: "Find in pane", exact: true });
}
function status(page: Page) {
  return page.getByRole("status", { name: "Find matches" });
}
async function openChatFind(page: Page) {
  await page.getByTestId("assistant-message").filter({ visible: true }).last().click();
  await page.keyboard.press("ControlOrMeta+f");
  await expect(query(page)).toBeFocused();
}
async function searchChat(page: Page, text: string) {
  await openChatFind(page);
  await query(page).fill(text);
}
async function expectHighlight(page: Page, text: string) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entries = Array.from(CSS.highlights.entries()).filter(([name]) =>
          name.startsWith("paseo-chat-find-"),
        );
        const texts: string[] = [];
        for (const [, highlight] of entries) {
          for (const range of highlight) texts.push(range.toString());
        }
        return texts;
      }),
    )
    .toEqual([text]);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const entry = Array.from(CSS.highlights.entries()).find(([name]) =>
          name.startsWith("paseo-chat-find-"),
        );
        const range = entry && Array.from(entry[1])[0];
        if (!(range instanceof Range)) return false;
        const rect = range.getBoundingClientRect();
        const row = range.startContainer.parentElement?.closest(
          '[data-testid="agent-chat-scroll"]',
        );
        const viewport = row?.getBoundingClientRect();
        return (
          !!viewport && rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom
        );
      }),
    )
    .toBe(true);
}
async function nextMatch(page: Page) {
  await query(page).press("Enter");
}
async function previousMatch(page: Page) {
  await query(page).press("Shift+Enter");
}
async function expectFindStatus(page: Page, search: string, matches: string) {
  await query(page).fill(search);
  await expect(status(page)).toHaveText(matches, { timeout: 15_000 });
}
async function expectNextMatch(page: Page, matches: string, highlighted: string) {
  await nextMatch(page);
  await expect(status(page)).toHaveText(matches);
  await expectHighlight(page, highlighted);
}
async function closeFind(page: Page) {
  await query(page).press("Escape");
  await expect(query(page)).toHaveCount(0);
  await expect
    .poll(() =>
      page.evaluate(() =>
        Array.from(CSS.highlights.keys()).filter((key) => key.startsWith("paseo-chat-find-")),
      ),
    )
    .toEqual([]);
}

test("loads older history through prompt navigation and finds repeated rendered Markdown", async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-",
    title: "Chat Find",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    for (let index = 0; index < 45; index++) {
      await agent.client.sendAgentMessage(agent.agentId, `Prompt number ${index}`);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    const jumps = await trackPromptJumpRequests(page, agent.agentId);
    await openAgentRoute(page, agent);
    await expect(page.getByText("Prompt number 44", { exact: true })).toBeVisible();
    await expect(page.getByText("Prompt number 0", { exact: true })).toHaveCount(0);
    await searchChat(page, "hello world");
    await expectHighlight(page, "hello world");
    await expect(status(page)).toHaveText("1 of 90");
    await page.screenshot({ path: testInfo.outputPath("chat-find-highlight.png") });
    expect(jumps.requests()[0]).toMatchObject({ limit: 40, mergeWindow: true });
    await nextMatch(page);
    await expect(status(page)).toHaveText("2 of 90");
    await expectHighlight(page, "hello world");
    await previousMatch(page);
    await expect(status(page)).toHaveText("1 of 90");
    await query(page).fill("hello & world");
    await expectHighlight(page, "hello & world");
    await query(page).fill("a.b");
    await expectHighlight(page, "a.b");
    await query(page).fill("Prompt number 0");
    await expectHighlight(page, "Prompt number 0");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

// The scope of the search is the whole chat, so the counter is the position across
// every message that holds a hit, and Next walks off the end of one into the next.
const ACROSS_PROMPT = "Find scope-needle in this chat";
const ACROSS_RESPONSE = "Reply with scope-needle here.\n\nAnd scope-needle again there.";

/** The test id of the message that holds the current match, so it can be watched crossing one. */
async function highlightedMessage(page: Page) {
  return page.evaluate(() => {
    const entry = Array.from(CSS.highlights.entries()).find(([name]) =>
      name.startsWith("paseo-chat-find-"),
    );
    const range = entry && Array.from(entry[1])[0];
    if (!(range instanceof Range)) return null;
    const message = range.startContainer.parentElement?.closest<HTMLElement>(
      '[data-testid="user-message"], [data-testid="assistant-message"]',
    );
    return message?.dataset.testid ?? null;
  });
}
async function expectHighlightedMessage(page: Page, testId: string) {
  await expect.poll(() => highlightedMessage(page)).toBe(testId);
}

test("counts and steps through every match in the chat, not just the selected message", async ({
  page,
}, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-across-",
    title: "Chat Find across messages",
    initialPrompt: ACROSS_PROMPT,
    featureValues: { mockAssistantResponse: ACROSS_RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    // One hit in the prompt and two in the reply: three across the chat.
    await searchChat(page, "scope-needle");
    await expect(status(page)).toHaveText("1 of 3");
    await expectHighlight(page, "scope-needle");
    await expectHighlightedMessage(page, "user-message");
    await page.screenshot({ path: testInfo.outputPath("chat-find-across-messages.png") });
    await expectNextMatch(page, "2 of 3", "scope-needle");
    await expectHighlightedMessage(page, "assistant-message");
    await expectNextMatch(page, "3 of 3", "scope-needle");
    await expectHighlightedMessage(page, "assistant-message");
    await page.screenshot({ path: testInfo.outputPath("chat-find-last-match.png") });
    await expectNextMatch(page, "1 of 3", "scope-needle");
    await expectHighlightedMessage(page, "user-message");
    await previousMatch(page);
    await expect(status(page)).toHaveText("3 of 3");
    await expectHighlight(page, "scope-needle");
    await expectHighlightedMessage(page, "assistant-message");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

test("rejects invisible source matches and ignores a late reply after closing", async ({
  page,
}) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-cancel-",
    title: "Chat Find cancellation",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const gate = await installDaemonWebSocketGate(page);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    await searchChat(page, "hidden-destination");
    await expect(status(page)).toHaveText("No matches");
    await query(page).fill("first cell second cell");
    await expect(status(page)).toHaveText("No matches");
    gate.holdNextServerMessage("agent.timeline.search.response");
    await query(page).fill("hello world");
    await expect(status(page)).toHaveText("Searching…");
    await gate.waitForHeldServerMessage("agent.timeline.search.response");
    await closeFind(page);
    gate.releaseHeldServerMessage("agent.timeline.search.response");
    await searchChat(page, "a.b");
    await expectHighlight(page, "a.b");
    await closeFind(page);
  } finally {
    await agent.cleanup();
  }
});

test("shows a disconnected search failure and recovers with Retry", async ({ page }) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-retry-",
    title: "Chat Find retry",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    const gate = await installDaemonWebSocketGate(page);
    await openAgentRoute(page, agent);
    await expect(page.getByTestId("assistant-message").first()).toBeVisible();
    await gate.drop();
    await expectReconnectingToastVisible(page);
    await searchChat(page, "hello world");
    await expect(status(page)).toHaveText("Failed");
    await expect(
      page.getByText("Could not search this chat. Check the host connection and retry.", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    gate.restore();
    await expectReconnectingToastGone(page);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expectHighlight(page, "hello world");
  } finally {
    await agent.cleanup();
  }
});

interface StreamedReplyChat extends MockAgentWorkspace {
  /** Resolves once the streamed reply has finished arriving. */
  replyFinished(): Promise<void>;
}

/**
 * Opens the chat first, then streams a multi-block reply into it and waits for a
 * later block, so the block holding the early needles is no longer the growing row.
 */
async function openChatStreamingMultiBlockReply(page: Page): Promise<StreamedReplyChat> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-live-blocks-",
    title: "Chat Find live blocks",
    featureValues: {
      mockStreamingAssistantResponse: STREAMED_RESPONSE,
      mockStreamingAssistantIntervalMs: 60,
    },
  });
  try {
    await openAgentRoute(page, agent);
    await agent.client.sendAgentMessage(agent.agentId, "Stream a multi block answer");
    await expect(page.getByText("beta-needle", { exact: false }).last()).toBeVisible({
      timeout: 30_000,
    });
    return {
      ...agent,
      replyFinished: async () => {
        await agent.client.waitForFinish(agent.agentId, 60_000);
      },
    };
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

test("finds a hit in a message that streamed while the chat was open", async ({ page }) => {
  test.setTimeout(120_000);
  const chat = await openChatStreamingMultiBlockReply(page);
  try {
    await openChatFind(page);
    // The only hit is in the first paragraph, which is no longer the row that grows.
    await expectFindStatus(page, "alpha-needle", "1 of 1");
    await chat.replyFinished();
    await expectFindStatus(page, "beta-needle", "1 of 1");
    // One message, two Markdown blocks, one count across both.
    await expectFindStatus(page, "pair-needle", "1 of 2");
    await expectNextMatch(page, "2 of 2", "pair-needle");
    await closeFind(page);
  } finally {
    await chat.cleanup();
  }
});

/**
 * Opens a chat whose newest reply is a single message far taller than the viewport,
 * behind enough older turns that the oldest one is not hydrated yet.
 */
async function openChatWithVirtualizedTallMessage(page: Page): Promise<MockAgentWorkspace> {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-virtualized-",
    title: "Chat Find virtualized message",
    featureValues: { mockAssistantResponse: TALL_RESPONSE },
  });
  try {
    for (let index = 0; index < 6; index++) {
      await agent.client.sendAgentMessage(agent.agentId, `Prompt number ${index}`);
      await agent.client.waitForFinish(agent.agentId, 15_000);
    }
    await openAgentRoute(page, agent);
    await expect(page.getByText("Prompt number 5", { exact: true })).toBeVisible();
    await expect(page.getByText("Prompt number 0", { exact: true })).toHaveCount(0);
    return agent;
  } catch (error) {
    await agent.cleanup();
    throw error;
  }
}

// Every block row of the selected message must be mounted for Find to see it, whatever
// the virtualizer's scroll window holds. Otherwise a hit in a far paragraph is missing
// from the count and Next walks off to the next message instead.
test("counts every occurrence of a virtualized message and steps between them", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const chat = await openChatWithVirtualizedTallMessage(page);
  try {
    await openChatFind(page);
    await expectFindStatus(page, "span-needle", "1 of 12");
    await expectHighlight(page, "span-needle");
    await expectNextMatch(page, "2 of 12", "span-needle");
    await closeFind(page);
  } finally {
    await chat.cleanup();
  }
});

test("finds text beyond the normal render cap and restores the cap when Find closes", async ({
  page,
}) => {
  const tail = "oversized-tail-needle";
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-cap-",
    title: "Chat Find long message",
    initialPrompt: "Render a long response",
    // One paragraph, so the needle is past the render cap of the row that holds it.
    featureValues: { mockAssistantResponse: `${"background ".repeat(3100)}${tail}` },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    const message = page.getByTestId("assistant-message");
    await expect(message).toBeVisible();
    await expect(message).not.toContainText(tail);
    await searchChat(page, tail);
    await expectHighlight(page, tail);
    await closeFind(page);
    await expect(message).not.toContainText(tail);
    await expect(message.getByTestId("assistant-message-capped-notice")).toBeVisible();
  } finally {
    await agent.cleanup();
  }
});

async function findFromComposer(page: Page, shortcut: string, testInfo: TestInfo) {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "chat-find-composer-",
    title: "Chat Find from composer",
    initialPrompt: "Render the response",
    featureValues: { mockAssistantResponse: RESPONSE },
  });
  try {
    await agent.client.waitForFinish(agent.agentId, 15_000);
    await openAgentRoute(page, agent);
    await searchFromComposerWithoutLosingDraft(page, shortcut);
    await refocusFindAndReplaceQuery(page, shortcut);
    await page.screenshot({ path: testInfo.outputPath("find-from-composer.png") });
    await closeFind(page);
    await expectCommandCenterOwnsFindShortcut(page, shortcut);
    await fillComposerDraft(page, "Draft after closing Find");
    await expectComposerDraft(page, "Draft after closing Find");
  } finally {
    await agent.cleanup();
  }
}

test("opens and refocuses Find with Control+f from the composer on Linux", async ({
  page,
}, testInfo) => {
  // Chromium retains the host navigator.platform even when its user agent is overridden.
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setUserAgentOverride", {
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    platform: "Linux x86_64",
  });
  await findFromComposer(page, "Control+f", testInfo);
});

test.describe("macOS", () => {
  test.use({ userAgent: MAC_USER_AGENT });

  test("opens and refocuses Find with Meta+f from the composer", async ({ page }, testInfo) => {
    await findFromComposer(page, "Meta+f", testInfo);
  });

  // Control+F moves the caret forward on macOS, so chat Find must leave it alone.
  test("leaves Control+f to the composer", async ({ page }) => {
    const agent = await seedMockAgentWorkspace({
      repoPrefix: "chat-find-mac-control-f-",
      title: "Chat Find macOS Control+f",
      initialPrompt: "Render the response",
      featureValues: { mockAssistantResponse: RESPONSE },
    });
    try {
      await agent.client.waitForFinish(agent.agentId, 15_000);
      await openAgentRoute(page, agent);
      await fillComposerDraft(page, "Keep this draft");
      await expectComposerFocused(page);
      await recordComposerKeydown(page);
      await page.keyboard.press("Control+f");
      await expect
        .poll(() => recordedComposerFindKeydown(page))
        .toEqual([{ key: "f", defaultPrevented: false }]);
      await expect(query(page)).toHaveCount(0);
      await expectComposerFocused(page);
      await expectComposerDraft(page, "Keep this draft");
    } finally {
      await agent.cleanup();
    }
  });
});

interface RecordedKeydown {
  key: string;
  defaultPrevented: boolean;
}

/**
 * Chat Find listens on `document` in the capture phase, so the composer only ever
 * sees a Find keystroke after Find decided about it. That makes `defaultPrevented`
 * on the composer the evidence of who owns the key.
 */
async function recordComposerKeydown(page: Page) {
  await composerLocator(page).evaluate((element) => {
    const store = window as unknown as { __findKeydown: RecordedKeydown[] };
    store.__findKeydown = [];
    element.addEventListener("keydown", (event) => {
      store.__findKeydown.push({
        key: (event as KeyboardEvent).key,
        defaultPrevented: event.defaultPrevented,
      });
    });
  });
}

async function recordedComposerFindKeydown(page: Page): Promise<RecordedKeydown[]> {
  const recorded = await page.evaluate(
    () => (window as unknown as { __findKeydown: RecordedKeydown[] }).__findKeydown,
  );
  return recorded.filter((entry) => entry.key.toLowerCase() === "f");
}

async function openFindFromComposer(page: Page, shortcut: string) {
  await page.keyboard.press(shortcut);
  await expect(query(page)).toBeFocused();
}

async function searchFromComposerWithoutLosingDraft(page: Page, shortcut: string) {
  await fillComposerDraft(page, "Keep this draft");
  await expectComposerFocused(page);
  await openFindFromComposer(page, shortcut);
  await expectComposerDraft(page, "Keep this draft");
  await query(page).fill("hello world");
  await expectHighlight(page, "hello world");
}

async function refocusFindAndReplaceQuery(page: Page, shortcut: string) {
  await composerLocator(page).click();
  await expectComposerFocused(page);
  await openFindFromComposer(page, shortcut);
  await expect(query(page)).toHaveValue("hello world");
  await expectComposerDraft(page, "Keep this draft");
  await page.keyboard.type("a.b");
  await expect(query(page)).toHaveValue("a.b");
  await expectHighlight(page, "a.b");
}

async function expectCommandCenterOwnsFindShortcut(page: Page, shortcut: string) {
  await openCommandCenter(page);
  await page.keyboard.press(shortcut);
  await expect(page.getByTestId("command-center-panel")).toBeVisible();
  await expect(query(page)).toHaveCount(0);
  await closeCommandCenter(page);
}

function installUserMessageClipboardRecorder() {
  const previousClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  window.__paseoUserMessagePlainWrites = [];
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText(text: string) {
        window.__paseoUserMessagePlainWrites?.push(text);
        return Promise.resolve();
      },
    },
  });
  window.addEventListener(
    "pagehide",
    () => {
      if (previousClipboard) Object.defineProperty(navigator, "clipboard", previousClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      delete window.__paseoUserMessagePlainWrites;
    },
    { once: true },
  );
}

// This component contract uses Metro without the production-Find daemon fixture above.
envelopeTest.describe("Metro framed UserMessage component contract", () => {
  envelopeTest.use({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
  let fixtureUrl = "";
  const fixtureBundle =
    "/packages/app/e2e/support/user-message.fixture.bundle?platform=web&dev=false&minify=false&hot=false&lazy=true&transform.engine=hermes&transform.routerRoot=src%2Fapp";
  const fixtureHtml = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>html,body,#root{height:100%;margin:0}#root{display:flex}</style></head><body><div id="root"></div><script src="${fixtureBundle}"></script></body></html>`;

  envelopeTest.beforeAll(async ({ browserName: _browserName }, testInfo) => {
    envelopeTest.setTimeout(120_000);
    let phase = "before bundle request";
    try {
      const metroPort = process.env.E2E_METRO_PORT;
      if (!metroPort) throw new Error("E2E_METRO_PORT is required for the component fixture");
      const bundle = `http://localhost:${metroPort}${fixtureBundle}`;
      const compiled = await fetch(bundle, { signal: AbortSignal.timeout(120_000) });
      if (!compiled.ok) {
        throw new Error(`UserMessage fixture compilation failed: HTTP ${compiled.status}`);
      }
      await compiled.arrayBuffer();
      // Serve only this test document at Metro's origin. Relative lazy bundles still
      // reach real Metro through the network guard, without a custom server endpoint.
      fixtureUrl = `http://localhost:${metroPort}/envelope-user-message-fixture`;
    } catch (error) {
      try {
        await testInfo.attach("swarm-envelope-setup-first-error", {
          body: JSON.stringify({
            phase,
            name: error instanceof Error ? error.name : undefined,
            stack: error instanceof Error ? error.stack : String(error),
          }),
          contentType: "application/json",
        });
      } catch (captureError) {
        console.error("UserMessage fixture setup error capture failed", captureError);
      }
      throw error;
    }
  });

  async function installFixtureNetworkGuard(page: Page, testInfo: TestInfo) {
    const context = page.context();
    const metroPort = process.env.E2E_METRO_PORT;
    if (!metroPort) throw new Error("E2E_METRO_PORT is required for the network guard");
    const httpOrigins = [new URL(fixtureUrl).origin];
    const wsOrigins = httpOrigins.map((origin) => origin.replace(/^http:/, "ws:"));
    const runRoot = process.env.QA_METRO_RUN_ROOT;
    const ledgerPath = runRoot
      ? join(runRoot, "results", "swarm-envelope-network-ledger.json")
      : testInfo.outputPath("swarm-envelope-network-ledger.json");
    const ledger: {
      schemaVersion: number;
      guardInstalledBeforeNavigation: boolean;
      fixtureDocumentsServed: number;
      ownedOrigins: { http: string[]; ws: string[] };
      rows: Array<{
        seq: number;
        utc: string;
        transport: "http" | "ws";
        decision: "allow" | "reject";
        url: string;
      }>;
      violations: string[];
      closureErrors: string[];
      webSockets: Array<{
        id: number;
        url: string;
        owned: boolean;
        openedUTC: string;
        closedUTC: string | null;
      }>;
      contextClosed: boolean;
      finalizedUTC: string | null;
    } = {
      schemaVersion: 1,
      guardInstalledBeforeNavigation: false,
      fixtureDocumentsServed: 0,
      ownedOrigins: { http: httpOrigins, ws: wsOrigins },
      rows: [],
      violations: [],
      closureErrors: [],
      webSockets: [],
      contextClosed: false,
      finalizedUTC: null,
    };

    let pendingCallbacks = 0;

    function recordError(stage: string, error: unknown) {
      ledger.closureErrors.push(`${stage}: ${String(error)}`);
      persistLedger();
    }

    function persistLedger() {
      try {
        writeFileSync(ledgerPath, `${JSON.stringify(ledger)}\n`);
        return true;
      } catch (error) {
        ledger.closureErrors.push(`Ledger persistence failed: ${String(error)}`);
        console.error("UserMessage network ledger persistence failed", error);
        return false;
      }
    }

    function isOwned(target: string, transport: "http" | "ws") {
      const url = new URL(target);
      return !url.username && !url.password && ledger.ownedOrigins[transport].includes(url.origin);
    }

    function recordDecision(target: string, transport: "http" | "ws") {
      const allowed = isOwned(target, transport);
      ledger.rows.push({
        seq: ledger.rows.length + 1,
        utc: new Date().toISOString(),
        transport,
        decision: allowed ? "allow" : "reject",
        url: target,
      });
      if (!allowed) ledger.violations.push(`Rejected ${transport} ${target}`);
      return persistLedger() && allowed;
    }

    function observePageWebSockets(observedPage: Page) {
      observedPage.on("websocket", (socket) => {
        try {
          const wire: (typeof ledger.webSockets)[number] = {
            id: ledger.webSockets.length + 1,
            url: socket.url(),
            owned: isOwned(socket.url(), "ws"),
            openedUTC: new Date().toISOString(),
            closedUTC: null,
          };
          ledger.webSockets.push(wire);
          if (!wire.owned) ledger.violations.push(`Unexpected wire websocket ${wire.url}`);
          persistLedger();
          socket.once("close", () => {
            wire.closedUTC = new Date().toISOString();
            persistLedger();
          });
          socket.once("socketerror", (error) => {
            ledger.closureErrors.push(`WebSocket failed: ${String(error)}`);
            persistLedger();
          });
        } catch (error) {
          recordError("WebSocket observation failed", error);
        }
      });
    }

    observePageWebSockets(page);
    context.on("page", observePageWebSockets);
    context.once("close", () => {
      ledger.contextClosed = true;
      ledger.finalizedUTC = new Date().toISOString();
      persistLedger();
    });
    await context.route("**/*", async (route) => {
      pendingCallbacks += 1;
      try {
        const allowed = recordDecision(route.request().url(), "http");
        if (!allowed) {
          await route.abort("blockedbyclient");
        } else if (
          route.request().url() === fixtureUrl &&
          route.request().method() === "GET" &&
          route.request().resourceType() === "document"
        ) {
          ledger.fixtureDocumentsServed += 1;
          await route.fulfill({ contentType: "text/html; charset=utf-8", body: fixtureHtml });
        } else {
          await route.continue();
        }
      } catch (error) {
        recordError("HTTP route failed", error);
      } finally {
        pendingCallbacks -= 1;
      }
    });
    await context.routeWebSocket("**/*", async (socket) => {
      pendingCallbacks += 1;
      try {
        const allowed = recordDecision(socket.url(), "ws");
        if (allowed) socket.connectToServer();
        else await socket.close({ code: 1008, reason: "Outside owned fixture origins" });
      } catch (error) {
        recordError("WebSocket route failed", error);
      } finally {
        pendingCallbacks -= 1;
      }
    });
    function hasRealWirePairs() {
      const requested = new Map<string, number>();
      for (const row of ledger.rows) {
        if (row.transport === "ws" && row.decision === "allow") {
          requested.set(row.url, (requested.get(row.url) ?? 0) + 1);
        }
      }
      const observed = new Map<string, number>();
      const ids = new Set<number>();
      for (const [index, wire] of ledger.webSockets.entries()) {
        if (
          wire.id !== index + 1 ||
          ids.has(wire.id) ||
          !wire.owned ||
          !wire.openedUTC ||
          !wire.closedUTC ||
          !isOwned(wire.url, "ws")
        )
          return false;
        ids.add(wire.id);
        observed.set(wire.url, (observed.get(wire.url) ?? 0) + 1);
      }
      if (requested.size !== observed.size) return false;
      for (const [url, count] of requested) {
        if (observed.get(url) !== count) return false;
      }
      return true;
    }

    function isSettled() {
      return pendingCallbacks === 0 && hasRealWirePairs();
    }

    async function finish() {
      const failures: Array<{ error: unknown }> = [];
      try {
        await expect.poll(isSettled).toBe(true);
      } catch (error) {
        failures.push({ error });
        recordError("Network callbacks or wires did not settle", error);
      }
      if (!persistLedger()) {
        failures.push({ error: new Error("Fresh terminal network ledger persistence failed") });
      }
      try {
        expect(pendingCallbacks).toBe(0);
        expect(ledger.schemaVersion).toBe(1);
        expect(ledger.guardInstalledBeforeNavigation).toBe(true);
        expect(ledger.fixtureDocumentsServed).toBe(1);
        expect(ledger.contextClosed).toBe(true);
        expect(ledger.finalizedUTC).not.toBeNull();
        expect(ledger.violations).toEqual([]);
        expect(ledger.closureErrors).toEqual([]);
        expect(ledger.rows.length).toBeGreaterThan(0);
        for (const [index, row] of ledger.rows.entries()) {
          expect(row.seq).toBe(index + 1);
          expect(row.utc).not.toBe("");
          expect(row.decision).toBe("allow");
          expect(isOwned(row.url, row.transport)).toBe(true);
        }
        expect(hasRealWirePairs()).toBe(true);
      } catch (error) {
        failures.push({ error });
        recordError("Terminal network ledger validation failed", error);
      }
      if (failures[0]) throw failures[0].error;
    }

    ledger.guardInstalledBeforeNavigation = true;
    if (!persistLedger()) throw new Error("The network guard ledger could not be persisted");
    return { ledger, recordError, finish };
  }

  async function readRanges(page: Page, queryText: string, useRendered = false) {
    return page.evaluate(
      ({ search, rendered }) => {
        const fixture: UserMessageFixtureBridge | undefined = window.__paseoUserMessageFixture;
        if (!fixture) throw new Error("The real UserMessage fixture bridge is not ready");
        const ranges = rendered
          ? fixture.readRenderedRanges(search)
          : fixture.readMessageRanges(search);
        return ranges.map((range) => ({
          isRange: range instanceof Range,
          text: range.toString(),
          startOffset: range.startOffset,
          connected: range.startContainer.isConnected && range.endContainer.isConnected,
        }));
      },
      { search: queryText, rendered: useRendered },
    );
  }

  async function readPlainWrites(page: Page) {
    return page.evaluate(() => window.__paseoUserMessagePlainWrites);
  }

  envelopeTest(
    "preserves exact tagged text, body ranges, attachment and ordinary plain Copy",
    async ({ page }, testInfo) => {
      const original = "<paseo-swarm-team-message>\nİ😀find **body**\n</paseo-swarm-team-message>";
      const pageErrors: string[] = [];
      const consoleMessages: Array<{ type: string; text: string }> = [];
      const captureError = (error: Error) => pageErrors.push(error.message);
      const captureConsole = (message: ConsoleMessage) => {
        consoleMessages.push({ type: message.type(), text: message.text() });
      };
      page.on("pageerror", captureError);
      page.on("console", captureConsole);
      await page.addInitScript(installUserMessageClipboardRecorder);
      let failed = false;
      let documentCleanupFailure: { error: unknown } | undefined;
      const terminalFailures: Array<{ stage: string; error: unknown }> = [];
      let networkGuard: Awaited<ReturnType<typeof installFixtureNetworkGuard>> | undefined;
      let phase = "before fixture navigation";
      try {
        phase = "before network guard installation";
        networkGuard = await installFixtureNetworkGuard(page, testInfo);
        phase = "before fixture navigation";
        await page.goto(fixtureUrl);
        phase = "initial expanded assertions";
        const row = page.locator('[data-message-id="mounted-envelope-message"]');
        const header = row.getByRole("button", { name: "Team message", exact: true });
        const originalToggle = row.getByTestId("swarm-envelope-original-toggle");
        const originalSection = row.getByTestId("swarm-envelope-original-section");
        const originalChevron = originalToggle.getByTestId("swarm-envelope-original-chevron");
        const body = row.getByTestId("swarm-envelope-body");
        const raw = row.getByTestId("swarm-envelope-original");
        const attachment = row.getByText("Attached note", { exact: true });
        const expectedRange = [
          { isRange: true, text: "find body", startOffset: 3, connected: true },
        ];
        const badge = row.getByTestId("swarm-envelope-badge");
        const assertFullWidthEnvelope = async () => {
          await expect(badge).toHaveCount(1);
          await expect(badge).toHaveCSS("width", "390px");
          await expect(badge).toHaveCSS("margin-left", "0px");
          await expect(badge).toHaveCSS("margin-right", "0px");
          const geometry = await badge.evaluate((element) => {
            const message = element.closest('[data-testid="user-message"]');
            const messageRow = message?.closest('[data-message-id="mounted-envelope-message"]');
            if (!element.isConnected || !message || !messageRow) {
              throw new Error("The envelope must remain attached to its exact message row");
            }
            const cardRect = element.getBoundingClientRect();
            const rowRect = messageRow.getBoundingClientRect();
            const ancestors = [];
            for (let parent = element.parentElement; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              ancestors.push({
                backgroundColor: style.backgroundColor,
                padding: style.padding,
                borderRadius: style.borderRadius,
              });
              if (parent === message) break;
            }
            return {
              card: { left: cardRect.left, right: cardRect.right, width: cardRect.width },
              row: { left: rowRect.left, right: rowRect.right, width: rowRect.width },
              ancestors,
            };
          });
          expect(geometry.card).toEqual(geometry.row);
          expect(geometry.ancestors.length).toBeGreaterThan(0);
          for (const ancestor of geometry.ancestors) {
            expect(ancestor).toEqual({
              backgroundColor: "rgba(0, 0, 0, 0)",
              padding: "0px",
              borderRadius: "0px",
            });
          }
        };
        const assertSharedFrame = async (stage: string) => {
          const frame = await badge.evaluate((element) => {
            const main = element.firstElementChild;
            const content = element.querySelector('[data-testid="swarm-envelope-body"]');
            const section = element.querySelector(
              '[data-testid="swarm-envelope-original-section"]',
            );
            const detail = content?.parentElement;
            if (!main || !content || !section || !detail || section.parentElement !== detail) {
              throw new Error("Body and original section must share the same badge details frame");
            }
            const bounds = (node: Element) => {
              const rect = node.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
            };
            const corners = (node: Element) => {
              const css = getComputedStyle(node);
              return {
                topLeft: css.borderTopLeftRadius,
                topRight: css.borderTopRightRadius,
                bottomLeft: css.borderBottomLeftRadius,
                bottomRight: css.borderBottomRightRadius,
              };
            };
            const detailCss = getComputedStyle(detail);
            const sectionCss = getComputedStyle(section);
            return {
              badge: bounds(element),
              main: bounds(main),
              detail: bounds(detail),
              section: bounds(section),
              mainCorners: corners(main),
              detailCorners: corners(detail),
              sectionCorners: corners(section),
              detailOverflow: detailCss.overflow,
              leftBorder: Number.parseFloat(detailCss.borderLeftWidth),
              rightBorder: Number.parseFloat(detailCss.borderRightWidth),
              bottomBorder: Number.parseFloat(detailCss.borderBottomWidth),
              divider: Number.parseFloat(sectionCss.borderTopWidth),
              sectionSideBorders: [
                sectionCss.borderLeftWidth,
                sectionCss.borderRightWidth,
                sectionCss.borderBottomWidth,
              ],
            };
          });
          expect(frame.main.left).toBe(frame.badge.left);
          expect(frame.main.right).toBe(frame.badge.right);
          expect(frame.detail.left).toBe(frame.badge.left);
          expect(frame.detail.right).toBe(frame.badge.right);
          expect(frame.main.bottom).toBe(frame.detail.top);
          expect(frame.section.left).toBe(frame.detail.left + frame.leftBorder);
          expect(frame.section.right).toBe(frame.detail.right - frame.rightBorder);
          expect(frame.section.bottom).toBe(frame.detail.bottom - frame.bottomBorder);
          expect(frame.detail.bottom).toBe(frame.badge.bottom);
          expect(frame.detailOverflow).toBe("hidden");
          expect(frame.divider).toBeGreaterThan(0);
          expect(frame.sectionSideBorders).toEqual(["0px", "0px", "0px"]);
          expect(frame.sectionCorners).toEqual({
            topLeft: "0px",
            topRight: "0px",
            bottomLeft: "0px",
            bottomRight: "0px",
          });
          expect(frame.mainCorners.bottomLeft).toBe("0px");
          expect(frame.mainCorners.bottomRight).toBe("0px");
          expect(Number.parseFloat(frame.detailCorners.bottomLeft)).toBeGreaterThan(0);
          expect(Number.parseFloat(frame.detailCorners.bottomRight)).toBeGreaterThan(0);
          expect(frame.detailCorners.bottomLeft).toBe(frame.mainCorners.topLeft);
          expect(frame.detailCorners.bottomRight).toBe(frame.mainCorners.topRight);
          await testInfo.attach(`swarm-envelope-frame-${stage}`, {
            body: JSON.stringify(frame),
            contentType: "application/json",
          });
          return frame;
        };
        const readOriginalChevron = async () => {
          await expect(originalChevron).toBeVisible();
          await expect(originalChevron.locator("svg")).toHaveCount(1);
          await expect(originalChevron.locator("path")).toHaveCount(1);
          await expect(originalChevron.locator("circle")).toHaveCount(0);
          const glyph = await originalChevron.evaluate((element) => ({
            path: element.querySelector("path")?.getAttribute("d"),
            transform: getComputedStyle(element).transform,
          }));
          expect(glyph.path).toMatch(/\d/);
          return glyph;
        };
        const readOriginalFeedback = () =>
          originalToggle.evaluate((element) => {
            let text: Element | undefined;
            for (const node of element.querySelectorAll("*")) {
              if (node.childElementCount === 0 && node.textContent === "Original message") {
                text = node;
                break;
              }
            }
            if (!text) throw new Error("The fixed Original message label must remain rendered");
            const css = getComputedStyle(element);
            return {
              color: getComputedStyle(text).color,
              background: css.backgroundColor,
              opacity: Number(css.opacity),
            };
          });
        await expect(row).toHaveCSS("width", "390px");
        expect(
          await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })),
        ).toEqual({ width: 1280, height: 720 });
        await expect(row.getByTestId("swarm-envelope-card")).toHaveCount(1);
        await assertFullWidthEnvelope();
        await expect(row.getByTestId("user-message")).toHaveAttribute("aria-busy", "false");
        await expect(header).toHaveAttribute("aria-expanded", "true");
        await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
        await expect(originalToggle).toHaveAccessibleName("Original message");
        await expect(originalSection).toBeVisible();
        await expect(raw).toHaveCount(0);
        const closedChevron = await readOriginalChevron();
        const idleFeedback = await readOriginalFeedback();
        const initialFrame = await assertSharedFrame("original-closed");
        await expect(attachment).toBeVisible();
        await expect(row.getByTestId("user-message-timestamp")).not.toHaveText("");
        await expect(row.locator('[data-message-text="true"]')).toHaveCount(1);
        expect(await page.evaluate(() => window.__paseoUserMessageFixture?.readInput())).toEqual({
          original,
          attachments: [
            {
              type: "text",
              mimeType: "text/plain",
              title: "Attached note",
              text: "Existing attachment body",
            },
          ],
          timestamp: 1_700_000_000_000,
        });
        await expect.poll(() => readRanges(page, "find body")).toEqual(expectedRange);
        expect(await readRanges(page, "Original message", true)).toEqual([]);
        expect(await readRanges(page, "Team message", true)).toEqual([]);
        await expect(
          row.getByRole("button", { name: /approve|allow|deny|verified|system/i }),
        ).toHaveCount(0);
        await page.screenshot({ path: testInfo.outputPath("swarm-envelope-expanded.png") });

        phase = "collapsed body and first Copy";
        await header.click();
        await expect(header).toHaveAttribute("aria-expanded", "false");
        await expect.poll(() => readRanges(page, "find body")).toEqual([]);
        await expect(body).toHaveCount(0);
        await expect(originalSection).toHaveCount(0);
        await expect(originalToggle).toHaveCount(0);
        await expect(raw).toHaveCount(0);
        await expect(attachment).toBeVisible();
        const hoverTarget = row.locator('[data-testid="user-message"] > div').first();
        await hoverTarget.hover();
        const trailing = row.getByTestId("user-message-trailing-row");
        await expect(trailing).toHaveCSS("opacity", "1");
        await expect(trailing).not.toHaveCSS("pointer-events", "none");
        const copy = row.getByRole("button", { name: "Copy message", exact: true });
        await expect(copy).toBeVisible();
        expect((await copy.boundingBox())?.height).toBeGreaterThan(0);
        await copy.click();
        await expect.poll(() => readPlainWrites(page)).toEqual([original]);
        await expect(row.getByRole("button", { name: "Copied", exact: true })).toBeVisible();

        phase = "original keyboard focus and activation";
        await header.click();
        await expect(header).toHaveAttribute("aria-expanded", "true");
        await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
        await page.mouse.move(1000, 650);
        // The existing badge detail Pressable is the next tab stop before its disclosure.
        await page.keyboard.press("Tab");
        await expect(body.locator("..")).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(originalToggle).toBeFocused();
        await expect
          .poll(async () => (await readOriginalFeedback()).background)
          .not.toBe(idleFeedback.background);
        expect(await readOriginalChevron()).toEqual(closedChevron);
        await page.screenshot({ path: testInfo.outputPath("swarm-envelope-original-focus.png") });
        await page.keyboard.press("Enter");
        await expect(originalToggle).toHaveAttribute("aria-expanded", "true");
        await expect(originalToggle).toHaveAccessibleName("Original message");
        expect(await raw.textContent()).toBe(original);
        await expect.poll(() => readRanges(page, "find body")).toEqual(expectedRange);
        await page.keyboard.press("Space");
        await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
        await expect(originalToggle).toBeFocused();
        await expect(raw).toHaveCount(0);
        expect(await readOriginalChevron()).toEqual(closedChevron);

        phase = "original hover and held pointer press";
        await page.mouse.click(1000, 650);
        await originalToggle.hover();
        await expect
          .poll(async () => (await readOriginalFeedback()).color)
          .not.toBe(idleFeedback.color);
        expect(await readOriginalChevron()).toEqual(closedChevron);
        await expect(originalToggle).toHaveAccessibleName("Original message");
        await page.screenshot({ path: testInfo.outputPath("swarm-envelope-original-hover.png") });
        const hoverFeedback = await readOriginalFeedback();
        const toggleBounds = await originalToggle.boundingBox();
        if (!toggleBounds)
          throw new Error("The visible Original message row needs a pointer hit rectangle");
        await page.mouse.move(
          toggleBounds.x + toggleBounds.width / 2,
          toggleBounds.y + toggleBounds.height / 2,
        );
        await page.mouse.down();
        let pressedFailure: { error: unknown } | undefined;
        try {
          await expect
            .poll(async () => (await readOriginalFeedback()).opacity)
            .toBeLessThan(hoverFeedback.opacity);
          expect((await readOriginalFeedback()).opacity).toBeGreaterThan(0);
          expect(await readOriginalChevron()).toEqual(closedChevron);
          await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
          await expect(originalToggle).toHaveAccessibleName("Original message");
          await page.screenshot({
            path: testInfo.outputPath("swarm-envelope-original-pressed.png"),
          });
        } catch (pressedError) {
          pressedFailure = { error: pressedError };
          throw pressedError;
        } finally {
          await page.mouse.up().catch((releaseError: unknown) => {
            if (!pressedFailure) throw releaseError;
            console.error(
              "Original message pointer release failed after the first error",
              releaseError,
            );
          });
        }

        phase = "original disclosure and second Copy";
        await expect(originalToggle).toHaveAttribute("aria-expanded", "true");
        await expect(originalToggle).toHaveAccessibleName("Original message");
        const openChevron = await readOriginalChevron();
        expect(openChevron.path).toBe(closedChevron.path);
        expect(openChevron.transform).not.toBe(closedChevron.transform);
        expect(await raw.textContent()).toBe(original);
        await expect(badge.getByTestId("swarm-envelope-original")).toHaveCount(1);
        await expect.poll(() => readRanges(page, "find body")).toEqual(expectedRange);
        expect(await readRanges(page, "<paseo-swarm-team-message>")).toEqual([]);
        expect(await readRanges(page, "</paseo-swarm-team-message>")).toEqual([]);
        expect(await readRanges(page, "paseo-swarm-team-message", true)).toEqual([]);
        expect(await readRanges(page, "Original message", true)).toEqual([]);
        await assertSharedFrame("original-open");
        await expect(attachment).toBeVisible();
        await hoverTarget.hover();
        await row.getByRole("button", { name: /^(Copy message|Copied)$/ }).click();
        await expect.poll(() => readPlainWrites(page)).toEqual([original, original]);
        await expect(row.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("swarm-envelope-original.png") });

        phase = "main collapse hides original and preserves its state";
        await header.click();
        await expect(header).toHaveAttribute("aria-expanded", "false");
        await expect(body).toHaveCount(0);
        await expect(originalSection).toHaveCount(0);
        await expect(originalToggle).toHaveCount(0);
        await expect(raw).toHaveCount(0);
        await expect.poll(() => readRanges(page, "find body")).toEqual([]);
        const collapsedCorners = await header.evaluate((element) => {
          const css = getComputedStyle(element);
          return { left: css.borderBottomLeftRadius, right: css.borderBottomRightRadius };
        });
        expect(collapsedCorners).toEqual({
          left: initialFrame.detailCorners.bottomLeft,
          right: initialFrame.detailCorners.bottomRight,
        });
        await assertFullWidthEnvelope();
        await expect(attachment).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath("swarm-envelope-main-collapsed.png") });

        phase = "reopened body restores original disclosure";
        await header.click();
        await expect(header).toHaveAttribute("aria-expanded", "true");
        await expect(originalToggle).toHaveAttribute("aria-expanded", "true");
        await expect(originalToggle).toHaveAccessibleName("Original message");
        expect(await readOriginalChevron()).toEqual(openChevron);
        await assertFullWidthEnvelope();
        await assertSharedFrame("reopened-original-open");
        await expect.poll(() => readRanges(page, "find body")).toEqual(expectedRange);
        expect(await raw.textContent()).toBe(original);
        await page.screenshot({ path: testInfo.outputPath("swarm-envelope-reopened.png") });
        await originalToggle.click();
        await expect(originalToggle).toHaveAttribute("aria-expanded", "false");
        await expect(originalToggle).toHaveAccessibleName("Original message");
        await expect(raw).toHaveCount(0);
        expect(await readOriginalChevron()).toEqual(closedChevron);
        await assertSharedFrame("reopened-original-closed");
        await expect.poll(() => readRanges(page, "find body")).toEqual(expectedRange);
        await expect(attachment).toBeVisible();
        expect(
          await page.evaluate(() => window.__paseoUserMessageFixture?.readToastErrorCount()),
        ).toBe(0);
        expect(pageErrors).toEqual([]);
        expect(consoleMessages.filter((message) => message.type === "error")).toEqual([]);
        expect(networkGuard.ledger.violations).toEqual([]);
        expect(networkGuard.ledger.closureErrors).toEqual([]);
      } catch (error) {
        failed = true;
        try {
          await testInfo.attach("swarm-envelope-first-error", {
            body: JSON.stringify({
              phase,
              name: error instanceof Error ? error.name : undefined,
              stack: error instanceof Error ? error.stack : String(error),
              pageErrors,
              consoleMessages,
              pageClosed: page.isClosed(),
            }),
            contentType: "application/json",
          });
          if (!page.isClosed()) {
            await page.screenshot({
              path: testInfo.outputPath("swarm-envelope-first-failure.png"),
            });
            await testInfo.attach("swarm-envelope-first-failure.html", {
              body: await page.content(),
              contentType: "text/html",
            });
          }
        } catch (captureFailure) {
          console.error("UserMessage fixture first-error capture failed", captureFailure);
        }
        throw error;
      } finally {
        page.off("pageerror", captureError);
        page.off("console", captureConsole);
        try {
          if (!page.isClosed()) await page.goto("about:blank");
        } catch (cleanupError) {
          if (failed) console.error("UserMessage fixture document cleanup failed", cleanupError);
          else documentCleanupFailure = { error: cleanupError };
        }
        try {
          await page.context().close();
        } catch (error) {
          terminalFailures.push({ stage: "context close", error });
          networkGuard?.recordError("Context close failed", error);
        }
        try {
          if (networkGuard) await networkGuard.finish();
          else
            terminalFailures.push({
              stage: "network guard installation",
              error: new Error("The network guard did not finish installation"),
            });
        } catch (error) {
          terminalFailures.push({ stage: "terminal network validation", error });
        }
        if (terminalFailures.length) {
          try {
            await testInfo.attach("swarm-envelope-terminal-errors", {
              body: JSON.stringify(
                terminalFailures.map((failure) => ({
                  stage: failure.stage,
                  name: failure.error instanceof Error ? failure.error.name : undefined,
                  stack:
                    failure.error instanceof Error ? failure.error.stack : String(failure.error),
                })),
              ),
              contentType: "application/json",
            });
          } catch (error) {
            terminalFailures.push({ stage: "terminal error capture", error });
            console.error("UserMessage terminal error capture failed", error);
          }
        }
      }
      if (documentCleanupFailure) throw documentCleanupFailure.error;
      if (terminalFailures[0]) throw terminalFailures[0].error;
    },
  );
});
