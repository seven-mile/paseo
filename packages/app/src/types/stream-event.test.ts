import { describe, expect, it } from "vitest";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import type { ThoughtItem } from "@/types/stream";
import { applyStreamEvent, createUserMessage } from "@/types/stream";

const baseTimestamp = new Date(0);

const assistantChunk = (text: string, messageId?: string): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "codex",
  item: {
    type: "assistant_message",
    text,
    ...(messageId ? { messageId } : {}),
  },
});

const toolCallEvent = (): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "codex",
  item: {
    type: "tool_call",
    callId: "head-tail-tool-call",
    name: "run",
    status: "running",
    detail: {
      type: "unknown",
      input: { command: "echo hi" },
      output: null,
    },
    error: null,
  },
});

const completionEvent = (): AgentStreamEventPayload => ({
  type: "turn_completed",
  provider: "codex",
});

const permissionEvent = (): AgentStreamEventPayload => ({
  type: "permission_requested",
  provider: "codex",
  request: {
    id: "perm-1",
    provider: "codex",
    name: "test",
    kind: "tool",
  },
});

const reasoningChunk = (text: string): AgentStreamEventPayload => ({
  type: "timeline",
  provider: "claude",
  item: {
    type: "reasoning",
    text,
  },
});

describe("applyStreamEvent", () => {
  it("buffers reasoning chunks in head", () => {
    const result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Let me think..."),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(0);
    expect(result.head).toHaveLength(1);
    expect(result.head[0].kind).toBe("thought");
    expect((result.head[0] as ThoughtItem).text).toBe("Let me think...");
    expect((result.head[0] as ThoughtItem).status).toBe("loading");
  });

  it("accumulates reasoning chunks in head", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Let me "),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: reasoningChunk("think..."),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(0);
    expect(result.head).toHaveLength(1);
    expect((result.head[0] as ThoughtItem).text).toBe("Let me think...");
  });

  it("flushes reasoning to tail when tool call arrives", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Thinking..."),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: toolCallEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.head).toHaveLength(0);
    expect(result.tail).toHaveLength(2);
    expect(result.tail[0].kind).toBe("thought");
    expect((result.tail[0] as ThoughtItem).status).toBe("ready");
    expect(result.tail[1].kind).toBe("tool_call");
  });

  it("flushes head on turn completion", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: assistantChunk("Hello"),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: completionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.head).toHaveLength(0);
    expect(result.tail).toHaveLength(1);
    expect(result.tail[0].kind).toBe("assistant_message");
  });

  it("does not continue a tail assistant message when the incoming message id differs", () => {
    const result = applyStreamEvent({
      tail: [
        {
          kind: "assistant_message",
          id: "msg-first",
          messageId: "msg-first",
          text: "First answer.",
          timestamp: baseTimestamp,
        },
      ],
      head: [],
      event: assistantChunk("Second answer.", "msg-second"),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(1);
    expect(result.head).toHaveLength(1);
    expect(result.tail[0].kind).toBe("assistant_message");
    expect(result.head[0].kind).toBe("assistant_message");
    if (
      result.tail[0].kind === "assistant_message" &&
      result.head[0].kind === "assistant_message"
    ) {
      expect(result.tail[0].text).toBe("First answer.");
      expect(result.head[0].text).toBe("Second answer.");
      expect(result.head[0].messageId).toBe("msg-second");
    }
  });

  it("flushes reasoning when assistant message starts", () => {
    let result = applyStreamEvent({
      tail: [],
      head: [],
      event: reasoningChunk("Thinking..."),
      timestamp: baseTimestamp,
    });
    result = applyStreamEvent({
      tail: result.tail,
      head: result.head,
      event: assistantChunk("Here's my answer"),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toHaveLength(1);
    expect(result.tail[0].kind).toBe("thought");
    expect((result.tail[0] as ThoughtItem).status).toBe("ready");
    expect(result.head).toHaveLength(1);
    expect(result.head[0].kind).toBe("assistant_message");
  });

  it("keeps references stable for no-op events", () => {
    const tail: ReturnType<typeof applyStreamEvent>["tail"] = [];
    const head: ReturnType<typeof applyStreamEvent>["head"] = [];

    const result = applyStreamEvent({
      tail,
      head,
      event: permissionEvent(),
      timestamp: baseTimestamp,
    });

    expect(result.tail).toBe(tail);
    expect(result.head).toBe(head);
    expect(result.changedTail).toBe(false);
    expect(result.changedHead).toBe(false);
  });

  it("records the attachment summaries of a canonical user message", () => {
    const summaries = [
      { type: "image", mimeType: "image/png", size: 2048 },
      { type: "github_issue", title: "Crash on start", number: 7 },
    ];
    const event: AgentStreamEventPayload = {
      type: "timeline",
      provider: "codex",
      item: { type: "user_message", text: "See attached", messageId: "m1", attachments: summaries },
    };

    const result = applyStreamEvent({
      tail: [],
      head: [],
      event,
      timestamp: baseTimestamp,
      source: "canonical",
    });

    expect(result.tail).toMatchObject([
      { kind: "user_message", text: "See attached", attachmentSummaries: summaries },
    ]);
  });

  it("keeps the local attachments of a submitted message and adds its summaries", () => {
    const attachment = {
      type: "github_issue" as const,
      mimeType: "application/github-issue" as const,
      number: 7,
      title: "Crash on start",
      url: "https://github.com/getpaseo/paseo/issues/7",
    };
    const submitted = createUserMessage({
      clientMessageId: "c1",
      text: "See attached",
      timestamp: baseTimestamp,
      attachments: [attachment],
    });
    const summaries = [{ type: "github_issue", title: "Crash on start", number: 7 }];

    const result = applyStreamEvent({
      tail: [submitted],
      head: [],
      event: {
        type: "timeline",
        provider: "codex",
        item: {
          type: "user_message",
          text: "See attached",
          messageId: "m1",
          clientMessageId: "c1",
          attachments: summaries,
        },
      },
      timestamp: baseTimestamp,
      source: "canonical",
    });

    expect(result.tail).toMatchObject([
      { kind: "user_message", attachments: [attachment], attachmentSummaries: summaries },
    ]);
  });
});
