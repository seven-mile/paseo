import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { runPluginClientBundle, type PluginClientRuntime } from "@/plugins/evaluate";
import type { InstalledPlugin } from "@/plugins/types";
import {
  applyStreamEvent,
  hydrateStreamState,
  type StreamItem,
  type ToolCallItem,
  type UserMessageItem,
} from "@/types/stream";
import { transformTimelineItem, type TimelineItemTransform } from "@/plugins/timeline/model";
import { createStreamPresentation } from "./presentation";
import { parseSwarmEnvelope } from "@/swarm/system-envelope";
import {
  initialPrompt,
  messagePrompt,
  runtimeNotification,
} from "../../../../plugins/paseo-swarm/server/prompts";
import { buildAgentStreamRenderModel } from "./model";

const runtime = {
  paseo: {},
  async rpc() {},
  openSettings() {},
  openSurface() {},
  openPanel() {},
  addHeaderButton() {
    return { update() {}, remove() {} };
  },
  addComposerPill() {
    return { update() {}, remove() {} };
  },
} as unknown as PluginClientRuntime;

function installProbe(
  itemType: "assistant_message" | "tool_call" | "reasoning",
  condition = "true",
): InstalledPlugin {
  const clientBundle = `(function() {
    return { default: function(client) {
      client.addTimelineTransformer({
        id: "probe",
        query: { itemType: ${JSON.stringify(itemType)} },
        transform: function({ item, phase }) {
          if (!(${condition})) return undefined;
          return {
            items: [{
              type: "plugin",
              kind: "probe",
              version: 1,
              data: item.type === "tool_call"
                ? { callId: item.callId, name: item.name, status: item.status,
                    detail: item.detail, ...(item.metadata ? { metadata: item.metadata } : {}), error: item.error, phase: phase }
                : { text: item.text, phase: phase }
            }]
          };
        }
      });
      return function() {};
    } };
  })`;
  const evaluated = runPluginClientBundle("probe-plugin", clientBundle, runtime);
  return {
    ...evaluated,
    serverId: "host-1",
    clientBundle,
    lifetime: new AbortController(),
    queryClient: new QueryClient(),
    paseo: {} as InstalledPlugin["paseo"],
    invoke: async () => undefined,
  };
}

function installedTransform(plugin: InstalledPlugin): TimelineItemTransform {
  return (input) => transformTimelineItem({ ...input, plugins: [plugin] });
}

function toolCall(callId: string, name: string): ToolCallItem {
  return {
    kind: "tool_call",
    id: `tool-${callId}`,
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    payload: {
      source: "agent",
      data: {
        provider: "codex",
        callId,
        name,
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { callId }, output: { callId } },
      },
    },
  };
}

function pluginData(items: StreamItem[]): unknown[] {
  return items.flatMap((item) => (item.kind === "plugin" ? [item.data] : []));
}

const presentationOptions = { level: "overview" as const, isTurnActive: true };

function streamHarness(transform?: TimelineItemTransform) {
  let state: { tail: StreamItem[]; head: StreamItem[] } = { tail: [], head: [] };
  const present = createStreamPresentation();
  return {
    send(event: AgentStreamEventPayload) {
      state = applyStreamEvent({ ...state, event, timestamp: new Date(1000) });
      return this.render();
    },
    render(nextTransform = transform) {
      return present({ ...presentationOptions, ...state, transform: nextTransform });
    },
    source: () => state,
  };
}

function assistant(text: string, messageId = "message-1"): AgentStreamEventPayload {
  return {
    type: "timeline",
    provider: "claude",
    item: { type: "assistant_message", messageId, text },
  };
}

function rows(result: { tail: StreamItem[]; head: StreamItem[] }): StreamItem[] {
  return [...result.tail, ...result.head];
}

describe("stream presentation through installed plugins", () => {
  it("offers every source tool call to an installed transformer in Overview mode", () => {
    const calls = [toolCall("call-1", "bash"), toolCall("call-2", "read")];
    const rendered = createStreamPresentation()({
      ...presentationOptions,
      tail: calls,
      head: [],
      transform: installedTransform(installProbe("tool_call")),
    });
    expect(pluginData([...rendered.tail, ...rendered.head])).toMatchObject([
      { callId: "call-1", name: "bash", phase: "complete" },
      { callId: "call-2", name: "read", phase: "complete" },
    ]);
  });

  it.each([
    { type: "turn_completed", provider: "claude" },
    { type: "turn_canceled", provider: "claude", reason: "test cancellation" },
    { type: "turn_failed", provider: "claude", error: "test failure" },
  ] satisfies AgentStreamEventPayload[])(
    "streams accumulated assistant text with one identity through $type",
    (completion) => {
      const harness = streamHarness(installedTransform(installProbe("assistant_message")));
      const first = rows(harness.send(assistant("Header")));
      const fullText = "Header\n\n\n# Body\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n";
      const live = rows(harness.send(assistant(fullText.slice("Header".length))));
      const completed = rows(harness.send(completion));

      expect(pluginData(first)).toEqual([{ text: "Header", phase: "streaming" }]);
      expect(pluginData(live)).toEqual([{ text: fullText, phase: "streaming" }]);
      expect(pluginData(completed)).toEqual([{ text: fullText, phase: "complete" }]);
      expect(live.map((item) => item.id)).toEqual(first.map((item) => item.id));
      expect(completed.map((item) => item.id)).toEqual(first.map((item) => item.id));
      expect(rows(harness.source())).toMatchObject([{ kind: "assistant_message", text: fullText }]);
    },
  );

  it("finishes one message before streaming a different message ID", () => {
    const harness = streamHarness(installedTransform(installProbe("assistant_message")));
    harness.send(assistant("First\n\nBody", "first"));
    const result = harness.send(assistant("Second", "second"));
    expect(pluginData(rows(result))).toEqual([
      { text: "First\n\nBody", phase: "complete" },
      { text: "Second", phase: "streaming" },
    ]);
    expect(new Set(rows(result).map((item) => item.id)).size).toBe(2);
  });

  it("lets a plugin claim the accumulated message after earlier text used native Markdown", () => {
    const harness = streamHarness();
    harness.send(assistant("Header\n\nBody"));
    const transform = installedTransform(
      installProbe("assistant_message", 'item.text.includes("Body")'),
    );
    expect(pluginData(rows(harness.render(transform)))).toEqual([
      { text: "Header\n\nBody", phase: "streaming" },
    ]);
    expect(rows(harness.render(transform))).toHaveLength(1);
    expect(rows(harness.render()).map((item) => item.kind)).toEqual([
      "assistant_message",
      "assistant_message",
    ]);
  });

  it("keeps completed native blocks stable while the last block grows and finishes", () => {
    const harness = streamHarness();
    const first = harness.send(assistant("Intro\n\n![Image](image.png)"));
    const growing = harness.send(assistant("\n\nAfter\n"));
    const last = harness.send(assistant("- item"));
    const completed = harness.send({ type: "turn_completed", provider: "claude" });
    expect(first.tail).toMatchObject([{ text: "Intro", blockIndex: 0 }]);
    expect(first.head).toMatchObject([{ text: "![Image](image.png)", blockIndex: 1 }]);
    expect(growing.tail[0]).toBe(first.tail[0]);
    expect(growing.tail[1]).toBe(first.head[0]);
    expect(last.tail).toBe(growing.tail);
    expect(last.head).toMatchObject([{ text: "After\n- item", blockIndex: 2 }]);
    expect(completed.tail).toEqual(rows(last));
    expect(completed.tail[2]).toBe(last.head[0]);
    expect(completed.head).toEqual([]);
  });

  it("keeps blank lines inside an open native code fence", () => {
    const harness = streamHarness();
    harness.send(assistant("Intro\n\n```ts\nconst a = 1;"));
    const result = harness.send(assistant("\n\nconst b = 2;"));
    expect(result.tail).toMatchObject([{ text: "Intro" }]);
    expect(result.head).toMatchObject([{ text: "```ts\nconst a = 1;\n\nconst b = 2;" }]);
  });

  // Codex streams a line break and the next line's indent as their own chunks.
  it("keeps a line break when a chunk ends in the next line's indent", () => {
    const harness = streamHarness();
    harness.send(assistant("```mermaid\nflowchart TD\n    A[Start] --> B[Review]\n"));
    harness.send(assistant("   "));
    const result = harness.send(assistant(" B --> C[Finish]\n```"));
    expect(result.head).toMatchObject([
      { text: "```mermaid\nflowchart TD\n    A[Start] --> B[Review]\n    B --> C[Finish]\n```" },
    ]);
  });

  // One rendering path: a fetched message is the same block group as a streamed one,
  // which is what lets find, scroll-to-message and history reveal address it by id.
  // A link reference definition stays with the paragraph that uses it, so the split
  // never leaves an empty row behind and the reference still resolves.
  it("splits an assistant message into the same blocks through history and through the live head", () => {
    const source = hydrateStreamState([
      {
        event: assistant("[Link][docs]\n\n[docs]: https://example.com\n\nClosing paragraph."),
        timestamp: new Date(1000),
      },
    ]);
    const messageId = source[0]!.id;
    const present = (placement: "tail" | "head") =>
      rows(
        createStreamPresentation()({
          ...presentationOptions,
          tail: placement === "tail" ? source : [],
          head: placement === "head" ? source : [],
          transform: undefined,
        }),
      );
    expect(present("tail")).toMatchObject([
      {
        id: `${messageId}:block:0`,
        blockGroupId: messageId,
        blockIndex: 0,
        text: "[Link][docs]\n\n[docs]: https://example.com",
      },
      {
        id: `${messageId}:block:1`,
        blockGroupId: messageId,
        blockIndex: 1,
        text: "Closing paragraph.",
      },
    ]);
    const blocks = (items: StreamItem[]) =>
      items.map((item) => [item.id, item.kind === "assistant_message" ? item.text : null]);
    expect(blocks(present("head"))).toEqual(blocks(present("tail")));
  });

  // Rows are addressed by id from outside presentation, so the same text has to land on
  // the same ids whether the reader watched it arrive or opened the chat afterwards.
  it("gives a streamed message the block ids its hydrated text would have had", () => {
    const text = "Intro paragraph.\n\n# Heading\n\n- first\n- second\n\nClosing paragraph.";
    const harness = streamHarness();
    for (let end = 8; end < text.length; end += 8) {
      harness.send(assistant(text.slice(end - 8, end)));
    }
    harness.send(assistant(text.slice(text.length - (text.length % 8 || 8))));
    const streamed = rows(harness.send({ type: "turn_completed", provider: "claude" }));
    const hydrated = rows(
      createStreamPresentation()({
        ...presentationOptions,
        tail: hydrateStreamState([{ event: assistant(text), timestamp: new Date(1000) }]),
        head: [],
        transform: undefined,
      }),
    );
    expect(streamed.map((item) => item.id)).toEqual(hydrated.map((item) => item.id));
    expect(streamed.map((item) => item.kind === "assistant_message" && item.text)).toEqual(
      hydrated.map((item) => item.kind === "assistant_message" && item.text),
    );
  });

  it("repoints a block at the canonical source that replaced the streamed one", () => {
    const harness = streamHarness();
    harness.send(assistant("Streamed answer"));
    const streamed = rows(harness.render());
    expect(streamed[0]).not.toHaveProperty("timelineCursor");
    const source = harness.source();
    const live = source.head[0];
    if (live?.kind !== "assistant_message") throw new Error("Expected a live assistant message");
    const canonical = { ...live, timelineCursor: { epoch: "epoch-1", seq: 42 } };
    const present = createStreamPresentation();
    present({ ...presentationOptions, tail: [], head: [live], transform: undefined });
    const repointed = rows(
      present({ ...presentationOptions, tail: [], head: [canonical], transform: undefined }),
    );
    expect(repointed).toMatchObject([
      {
        id: streamed[0]!.id,
        text: "Streamed answer",
        timelineCursor: { epoch: "epoch-1", seq: 42 },
      },
    ]);
  });

  it("keeps a single-paragraph message a one-block group", () => {
    const source = hydrateStreamState([
      { event: assistant("Only one paragraph."), timestamp: new Date(1000) },
    ]);
    const messageId = source[0]!.id;
    const result = createStreamPresentation()({
      ...presentationOptions,
      tail: source,
      head: [],
      transform: undefined,
    });
    expect(result.tail).toMatchObject([
      {
        id: `${messageId}:block:0`,
        blockGroupId: messageId,
        blockIndex: 0,
        text: "Only one paragraph.",
      },
    ]);
    expect(result.tail[0]!.id).not.toBe(messageId);
  });

  it("continues to stream inline reasoning with a stable plugin row", () => {
    const harness = streamHarness(installedTransform(installProbe("reasoning")));
    const first = harness.send({
      type: "timeline",
      provider: "claude",
      item: { type: "reasoning", text: "First" },
    });
    const second = harness.send({
      type: "timeline",
      provider: "claude",
      item: { type: "reasoning", text: "\n\nSecond" },
    });
    const done = harness.send({ type: "turn_completed", provider: "claude" });
    expect(pluginData(rows(second))).toEqual([{ text: "First\n\nSecond", phase: "streaming" }]);
    expect(pluginData(rows(done))).toEqual([{ text: "First\n\nSecond", phase: "complete" }]);
    expect(rows(first)[0]?.id).toBe(rows(done)[0]?.id);
  });

  it("groups only unclaimed tools and passes unchanged tool details to the callback", () => {
    const calls = [
      toolCall("call-1", "read"),
      toolCall("call-2", "read"),
      toolCall("call-3", "bash"),
    ];
    const result = createStreamPresentation()({
      ...presentationOptions,
      isTurnActive: false,
      tail: calls,
      head: [],
      transform: installedTransform(installProbe("tool_call", 'item.name === "bash"')),
    });
    expect(result.groupsByHostId.get(result.tail[0]!.id)?.run.calls).toEqual(calls.slice(0, 2));
    expect(pluginData(rows(result))).toEqual([
      {
        callId: "call-3",
        name: "bash",
        status: "completed",
        error: null,
        detail: { type: "unknown", input: { callId: "call-3" }, output: { callId: "call-3" } },
        phase: "complete",
      },
    ]);
  });

  it.each([
    { status: "completed", error: null },
    { status: "failed", error: { message: "Command failed" } },
    { status: "canceled", error: null },
  ] as const)("keeps a tool card's identity and full payload through $status", (completion) => {
    const harness = streamHarness(installedTransform(installProbe("tool_call")));
    const source = {
      type: "tool_call" as const,
      callId: "call-1",
      name: "bash",
      detail: { type: "shell" as const, command: "pwd", cwd: "/repo" },
      metadata: { sequence: 1 },
    };
    const running = rows(
      harness.send({
        type: "timeline",
        provider: "claude",
        item: {
          ...source,
          status: "running",
          error: null,
        },
      }),
    );
    const terminalItem = { ...source, ...completion };
    const terminal = rows(
      harness.send({
        type: "timeline",
        provider: "claude",
        item: {
          ...terminalItem,
        },
      }),
    );
    expect(pluginData(running)).toMatchObject([
      { callId: "call-1", status: "running", phase: "streaming" },
    ]);
    expect(pluginData(terminal)).toEqual([
      {
        callId: source.callId,
        name: source.name,
        detail: source.detail,
        metadata: source.metadata,
        phase: "complete",
        status: completion.status,
        error: terminalItem.error,
      },
    ]);
    expect(terminal.map((item) => item.id)).toEqual(running.map((item) => item.id));
  });

  it("offers one complete live source assistant message to an installed transformer", () => {
    const sourceText =
      '[IMPORTANT: User invoked the "diagnose" skill; follow its instructions. Full skill below.]\n\n# Diagnose\n\nFind the root cause.';
    const event = {
      type: "timeline" as const,
      provider: "opencode" as const,
      item: { type: "assistant_message" as const, messageId: "message-1", text: sourceText },
    };
    const timestamp = new Date("2026-01-01T00:00:00.000Z");
    const transform = installedTransform(installProbe("assistant_message"));
    const present = createStreamPresentation();

    const fetched = hydrateStreamState([{ event, timestamp }]);
    const history = present({ ...presentationOptions, tail: fetched, head: [], transform });
    expect(pluginData(history.tail)).toEqual([{ text: sourceText, phase: "complete" }]);

    const stream = applyStreamEvent({
      tail: [],
      head: [],
      event,
      timestamp,
    });

    const rendered = present({ ...presentationOptions, ...stream, transform });
    expect(pluginData([...rendered.tail, ...rendered.head])).toEqual([
      { text: sourceText, phase: "streaming" },
    ]);
  });
});

function createTimestamp(seed: number): Date {
  return new Date(`2026-01-01T00:00:${seed.toString().padStart(2, "0")}.000Z`);
}

function userMessage(id: string, seed: number): UserMessageItem {
  return {
    kind: "user_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

function assistantMessage(
  id: string,
  seed: number,
): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    timestamp: createTimestamp(seed),
  };
}

describe("timeline presentation", () => {
  const present = createStreamPresentation();
  function projectTimelineItems(items: StreamItem[], transform?: TimelineItemTransform) {
    return present({ ...presentationOptions, tail: items, head: [], transform }).tail;
  }
  const envelope =
    "<spoken-input>\nPlease fix the voice chat.\n</spoken-input>\n<instruction>This message was spoken by the user. Respond using the speak tool only, not normal messages, because the user may not be looking at the chat.</instruction>";

  it.each(["live", "history"])(
    "shows only spoken words from a %s user message without mutating its source",
    (source) => {
      const item: UserMessageItem = Object.freeze({
        ...userMessage(source, 1),
        text: envelope,
        messageId: "provider-message",
        clientMessageId: "client-message",
        turnId: "turn-1",
        timelineCursor: { epoch: "epoch", seq: 12 },
      });
      const presentMessage = () =>
        present({
          ...presentationOptions,
          tail: source === "history" ? [item] : [],
          head: source === "live" ? [item] : [],
          transform: undefined,
        });
      const projected = rows(presentMessage());
      expect(projected).toEqual([
        { ...item, text: "Please fix the voice chat.", sourceText: envelope },
      ]);
      const model = buildAgentStreamRenderModel({
        tail: source === "history" ? projected : [],
        head: source === "live" ? projected : [],
        isTurnActive: source === "live",
        activeTurnStartedAt: item.timestamp,
        platform: "native",
        isMobileBreakpoint: true,
      });
      const rendered = [...model.history, ...model.segments.liveHead];
      expect(rendered).toContainEqual({
        ...item,
        text: "Please fix the voice chat.",
        sourceText: envelope,
      });
      expect(item.text).toBe(envelope);
      expect(rows(presentMessage())[0]).toBe(projected[0]);
    },
  );

  it("supports older envelopes and preserves multiline spoken content", () => {
    const item = {
      ...userMessage("legacy", 1),
      text: "<spoken-input>\nFirst line.\nSecond line with <example>XML</example>.\n</spoken-input>",
    };
    expect(projectTimelineItems([item])).toEqual([
      {
        ...item,
        text: "First line.\nSecond line with <example>XML</example>.",
        sourceText: item.text,
      },
    ]);
  });

  it("leaves ordinary messages, assistant examples and incomplete wrappers unchanged", () => {
    const items: StreamItem[] = [
      userMessage("ordinary", 1),
      { ...assistantMessage("example", 2), text: envelope },
      { ...userMessage("incomplete", 3), text: "<spoken-input>unfinished" },
      { ...userMessage("quoted", 4), text: "Explain this example: " + envelope },
      {
        ...userMessage("xml", 5),
        text: "<spoken-input>Example</spoken-input><instruction>Explain this XML.</instruction>",
      },
    ];
    expect(projectTimelineItems(items)).toEqual(
      items.map((item) =>
        item.kind === "assistant_message"
          ? { ...item, id: `${item.id}:block:0`, blockGroupId: item.id, blockIndex: 0 }
          : item,
      ),
    );
    expect(projectTimelineItems(items)[0]).toBe(items[0]);
  });

  it("keeps plugin transforms on the original source and respects replacements", () => {
    const source: StreamItem = { ...userMessage("spoken", 1), text: envelope };
    const inputs: string[] = [];
    const transformed = projectTimelineItems([source], ({ item, sourceId }) => {
      if (item.type === "user_message") inputs.push(item.text);
      return [
        {
          type: "plugin",
          pluginId: "test",
          id: sourceId,
          kind: "voice",
          version: 1,
          data: { text: "Custom voice row" },
        },
      ];
    });
    expect(inputs).toEqual([envelope]);
    expect(transformed).toMatchObject([{ kind: "plugin", data: { text: "Custom voice row" } }]);
    expect(projectTimelineItems([source], () => undefined)).toEqual([
      { ...source, text: "Please fix the voice chat.", sourceText: envelope },
    ]);
    expect(projectTimelineItems([source], () => [])).toEqual([]);
  });
});

describe("display-only Swarm message presentation", () => {
  const literal = "<paseo-swarm-team-message>\nA\nB\n</paseo-swarm-team-message>";
  const cases = [
    { kind: "settings", tag: "paseo-swarm-system-settings" },
    { kind: "team", tag: "paseo-swarm-team-message" },
    { kind: "runtime", tag: "paseo-swarm-runtime-notification" },
  ] as const;

  it("recognizes an existing literal without deriving identity or metadata", () => {
    expect(parseSwarmEnvelope(literal)).toEqual({ kind: "team", body: "A\nB" });
  });

  it.each(cases)(
    "retains opaque Unicode, nested tags and empty bodies for $kind",
    ({ kind, tag }) => {
      const body = `  İ中文😀\r\n</${tag}>\n${literal}\n  `;
      // A settings block ends at its first closing line; arbitrary tail text stays in the body.
      const settingsBody = "  İ中文😀\r\nOpaque settings  ";
      const expectedBody = kind === "settings" ? settingsBody : body;
      expect(parseSwarmEnvelope(`<${tag}>\n${expectedBody}\n</${tag}>`)).toEqual({
        kind,
        body: expectedBody,
      });
      expect(parseSwarmEnvelope(`<${tag}>\r\n${expectedBody}\r\n</${tag}>`)).toEqual({
        kind,
        body: expectedBody,
      });
      expect(parseSwarmEnvelope(`<${tag}>\n\n</${tag}>`)).toEqual({ kind, body: "" });
      expect(parseSwarmEnvelope(`<${tag}>\r\n</${tag}>`)).toEqual({ kind, body: "" });
    },
  );

  it("removes only the settings block delimiters and preserves the complete nested tail", () => {
    const tail = `\r\nYou are worker.\r\nProject working agreement:\r\n${literal}\r\n</paseo-swarm-system-settings>\r\nYour role guidance:\r\n中文😀\r\nOrientation: continue.  `;
    const input = `<paseo-swarm-system-settings>\r\nSettings\r\n</paseo-swarm-system-settings>${tail}`;
    expect(parseSwarmEnvelope(input)).toEqual({ kind: "settings", body: `Settings${tail}` });
  });

  it.each(cases)(
    "preserves a body's independent final CR in an LF $kind wrapper",
    ({ kind, tag }) => {
      const body = "中文😀\r";
      expect(parseSwarmEnvelope(`<${tag}>\n${body}\n</${tag}>`)).toEqual({ kind, body });
    },
  );

  it.each(cases)(
    "preserves a body's independent final CR in a CRLF $kind wrapper",
    ({ kind, tag }) => {
      const body = "中文😀\r";
      expect(parseSwarmEnvelope(`<${tag}>\r\n${body}\r\n</${tag}>`)).toEqual({ kind, body });
    },
  );

  it.each(cases)("rejects a CRLF $kind opening with an LF-only closing delimiter", ({ tag }) => {
    expect(parseSwarmEnvelope(`<${tag}>\r\nBody\n</${tag}>`)).toBeNull();
  });

  it.each(cases)(
    "interprets CR before an LF $kind closing as body text, not mixed framing",
    ({ kind, tag }) => {
      expect(parseSwarmEnvelope(`<${tag}>\nBody\r\n</${tag}>`)).toEqual({
        kind,
        body: "Body\r",
      });
    },
  );

  it("preserves independent CR and the complete settings tail without normalizing its line endings", () => {
    const tail = "\r\nProject agreement\nRole\r\nOrientation  ";
    expect(
      parseSwarmEnvelope(
        `<paseo-swarm-system-settings>\nSettings\r\n</paseo-swarm-system-settings>${tail}`,
      ),
    ).toEqual({
      kind: "settings",
      body: `Settings\r${tail}`,
    });
    expect(
      parseSwarmEnvelope(
        `<paseo-swarm-system-settings>\r\nSettings\r\r\n</paseo-swarm-system-settings>${tail}`,
      ),
    ).toEqual({
      kind: "settings",
      body: `Settings\r${tail}`,
    });
  });

  it("does not truncate settings containing further closing or nested markers", () => {
    const input =
      "<paseo-swarm-system-settings>\nFirst\n</paseo-swarm-system-settings>\nStill body\n<paseo-swarm-system-settings>\nNested\n</paseo-swarm-system-settings>\nFull orientation";
    expect(parseSwarmEnvelope(input)).toEqual({
      kind: "settings",
      body: "First\nStill body\n<paseo-swarm-system-settings>\nNested\n</paseo-swarm-system-settings>\nFull orientation",
    });
  });

  it.each(cases)("accepts same-kind concatenation as one $kind display card", ({ kind, tag }) => {
    const first = `<${tag}>\nFirst\n</${tag}>`;
    const second = `<${tag}>\nSecond\n</${tag}>`;
    const input = `${first}\n${second}`;
    const body = kind === "settings" ? `First\n${second}` : `First\n</${tag}>\n<${tag}>\nSecond`;
    expect(parseSwarmEnvelope(input)).toEqual({ kind, body });
  });

  it.each([
    "ordinary text",
    `quoted: ${literal}`,
    `\uFEFF${literal}`,
    `${literal}\n`,
    `\`\`\`text\n${literal}\n\`\`\``,
    literal.replace("<paseo-swarm-team-message>", "<paseo-swarm-team-message extra>"),
    literal.replace("</paseo-swarm-team-message>", "</wrong>"),
    literal.slice(0, -1),
    "<paseo-swarm-team-message>missing opening newline\n</paseo-swarm-team-message>",
    "<paseo-swarm-team-message>\nBody without closing newline</paseo-swarm-team-message>",
    "<paseo-swarm-runtime-notification>\nMissing close",
    "<paseo-swarm-system-settings>\nMissing close and complete working agreement",
    "<paseo-swarm-system-settings>\nBody\n</paseo-swarm-system-settings>unseparated tail",
    "<paseo-swarm-context>\nUnknown\n</paseo-swarm-context>",
    "<paseo-swarm-escalation>\nUnknown\n</paseo-swarm-escalation>",
    '<paseo-swarm-envelope>\n{"version":1,"kind":"team","bodyLength":0}\n\n\n</paseo-swarm-envelope>',
    "<paseo-system>\nExisting unrelated daemon message\n</paseo-system>",
  ])("leaves unknown, quoted and broken source text intact: %s", (input) => {
    const source = Object.freeze({ ...userMessage("raw", 1), text: input });
    const present = createStreamPresentation();
    const projected = rows(
      present({ ...presentationOptions, transform: undefined, tail: [source], head: [] }),
    );
    expect(parseSwarmEnvelope(input)).toBeNull();
    expect(projected).toEqual([source]);
    expect(projected[0]).toBe(source);
  });

  it.each(["live", "history", "import"])(
    "preserves user-written roles, identity and the complete Copy source through %s presentation",
    (path) => {
      const source = Object.freeze({
        ...userMessage("user-frame", 1),
        text: literal,
        messageId: "provider-id",
        clientMessageId: "client-id",
        turnId: "turn-id",
        timelineCursor: { epoch: "epoch", seq: 5 },
      });
      const present = createStreamPresentation();
      const installed = path === "live" ? source : { ...source };
      const projected = rows(
        present({
          ...presentationOptions,
          transform: undefined,
          tail: path === "live" ? [] : [installed],
          head: path === "live" ? [installed] : [],
        }),
      );
      expect(projected).toEqual([source]);
      expect(projected[0]).toBe(installed);
      const row = projected[0];
      expect(row.kind).toBe("user_message");
      if (row.kind !== "user_message") throw new Error("Expected original user role");
      expect(row.sourceText).toBeUndefined();
      expect(row.sourceText ?? row.text).toBe(literal);
      expect(parseSwarmEnvelope(row.sourceText ?? row.text)).toEqual({
        kind: "team",
        body: "A\nB",
      });
      expect(source.text).toBe(literal);
    },
  );

  it("does not promote tags nested inside spoken input or replace its complete Copy source", () => {
    const original = `<spoken-input>\n${literal}\n</spoken-input>`;
    const source = Object.freeze({ ...userMessage("spoken-frame", 1), text: original });
    const present = createStreamPresentation();
    const projected = rows(
      present({ ...presentationOptions, transform: undefined, tail: [source], head: [] }),
    );
    expect(projected).toEqual([{ ...source, text: literal, sourceText: original }]);
    const row = projected[0];
    if (row.kind !== "user_message") throw new Error("Expected original user role");
    expect(parseSwarmEnvelope(row.sourceText ?? row.text)).toBeNull();
    expect(row.sourceText ?? row.text).toBe(original);
    expect(source.text).toBe(original);
  });

  it("recognizes actual main settings and team producers without dropping current guidance or payloads", () => {
    const raw = `  人类😀\r\n${literal}\n</paseo-swarm-system-settings>  `;
    const settings = initialPrompt({
      pwa: {
        project: "Example",
        role: "developer",
        roleClass: "worker",
        projectBody: raw,
        roleBody: "Full role guidance",
        statuses: ["raw-status"],
        revision: "raw-revision",
      },
      agent: { name: "worker", roleClass: "worker", role: "developer", reportsTo: null },
      brief: "Full orientation",
    });
    const close = "\n</paseo-swarm-system-settings>";
    const closeAt = settings.indexOf(close);
    expect(closeAt).toBeGreaterThan(0);
    expect(parseSwarmEnvelope(settings)).toEqual({
      kind: "settings",
      body:
        settings.slice("<paseo-swarm-system-settings>\n".length, closeAt) +
        settings.slice(closeAt + close.length),
    });
    expect(parseSwarmEnvelope(settings)?.body).toContain("Use swarm_board_read when you start");
    expect(parseSwarmEnvelope(settings)?.body).toContain(raw);
    expect(parseSwarmEnvelope(settings)?.body).toContain("Full role guidance");
    expect(parseSwarmEnvelope(settings)?.body).toContain("Orientation: Full orientation");

    const humanBody = `A human added Activity raw-id to Task raw-task.\n${raw}`;
    const team = messagePrompt({
      sender: "raw.human",
      recipient: "raw.manager",
      taskId: "raw-task",
      message: humanBody,
    });
    expect(parseSwarmEnvelope(team)).toEqual({
      kind: "team",
      body: team.slice(
        "<paseo-swarm-team-message>\n".length,
        -"\n</paseo-swarm-team-message>".length,
      ),
    });
    expect(parseSwarmEnvelope(team)?.body).toContain(humanBody);
    expect(parseSwarmEnvelope(team)?.body).toContain("Delivery does not prove");
  });

  it.each([
    {
      status: "idle",
      label: "Agent raw.worker is idle.",
      payload:
        "idle means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.",
    },
    {
      status: "inactive",
      label: "Agent raw.worker is inactive.",
      payload:
        "inactive means no turn is executing; it does not describe task completion, success, failure, or waiting for other agents.",
    },
    {
      status: "completed",
      label: "Observed assistant text from this turn",
      payload: `  中文😀\r\n${literal}  `,
    },
    {
      status: "canceled",
      label: "Peek at assistant text from the interrupted turn (possibly incomplete)",
      payload: `  中文😀\r\n${literal}  `,
    },
    {
      status: "failed",
      label: "Peek at assistant text from the interrupted turn (possibly incomplete)",
      payload: `  中文😀\r\n${literal}  `,
    },
  ])("preserves the actual main runtime producer for $status", ({ status, label, payload }) => {
    const notification = runtimeNotification({
      agent: "raw.worker",
      manager: "raw.manager",
      status,
      outcome: "raw detail",
      report: `  中文😀\r\n${literal}  `,
    });
    const parsed = parseSwarmEnvelope(notification);
    expect(parsed).toEqual({
      kind: "runtime",
      body: notification.slice(
        "<paseo-swarm-runtime-notification>\n".length,
        -"\n</paseo-swarm-runtime-notification>".length,
      ),
    });
    expect(parsed?.body).toContain(label);
    expect(parsed?.body).toContain(payload);
    expect(parsed?.body).toContain(
      "Framework roster notification; this is not an agent-authored team message.",
    );
    expect(parsed?.body).toContain("continue coordinating until genuinely blocked or completed.");
  });

  it("retains the actual runtime no-text outcome without inventing a report", () => {
    const parsed = parseSwarmEnvelope(
      runtimeNotification({ agent: "worker", manager: "manager", status: "failed" }),
    );
    expect(parsed?.kind).toBe("runtime");
    expect(parsed?.body).toContain("No new assistant text is available for this turn.");
    expect(parsed?.body).toContain(
      "This runtime outcome does not establish Task completion, success, failure, or cancellation.",
    );
  });
});
