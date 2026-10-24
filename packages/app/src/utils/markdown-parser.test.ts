import { describe, expect, it } from "vitest";
import { createMarkdownParser } from "./markdown-parser";
import { createSwarmEnvelopeMarkdownParser } from "@/swarm/envelope-markdown";
import type { SwarmEnvelope } from "@/swarm/system-envelope";
import {
  messagePrompt,
  turnDigest,
  turnDigestRow,
} from "../../../../plugins/paseo-swarm/server/prompts";
import { parseSwarmEnvelope } from "@/swarm/system-envelope";

// Every string markdown-it's typographer would rewrite, with the character it
// would rewrite it to. Sourced from markdown-it/lib/rules_core/replacements.js
// and smartquotes.js. `--flag` is deliberately absent: the en-dash rules need
// whitespace or a word character on both sides, so a CLI flag after a space is
// never touched and asserting on it would prove nothing.
const REWRITTEN_BY_TYPOGRAPHER = [
  "(c)",
  "(C)",
  "(r)",
  "(R)",
  "(tm)",
  "(TM)",
  "(p)",
  "(P)",
  "+-",
  "two dots .. here",
  "wait for it...",
  "what????",
  "stop!!!!",
  "hmm,, ok",
  "a -- b",
  "word--word",
  "a --- b",
  'run --name="my repo"',
  "it's fine",
];

describe("createMarkdownParser", () => {
  it("renders every typographer-rewritten sequence verbatim", () => {
    const parser = createMarkdownParser({ linkify: true });

    for (const source of REWRITTEN_BY_TYPOGRAPHER) {
      expect(parser.renderInline(source)).toBe(escapeHtml(source));
    }
  });

  it("would fail if typographer were switched back on", () => {
    // Guards the assertion above: proves the fixture actually exercises the
    // rules, so a future refactor can't quietly make the test vacuous.
    const typographer = createMarkdownParser({ linkify: true });
    typographer.set({ typographer: true });

    for (const source of REWRITTEN_BY_TYPOGRAPHER) {
      expect(typographer.renderInline(source)).not.toBe(escapeHtml(source));
    }
  });

  it("rejects file:// links", () => {
    const parser = createMarkdownParser({ linkify: true });

    expect(parser.render("[open](file:///tmp/a.ts)")).not.toContain("href");
  });

  it("rejects javascript: links", () => {
    const parser = createMarkdownParser({ linkify: true });

    expect(parser.render("[x](javascript:alert(1))")).not.toContain("href");
  });

  it("linkifies bare URLs only when asked", () => {
    expect(createMarkdownParser({ linkify: true }).render("see https://paseo.sh now")).toContain(
      'href="https://paseo.sh"',
    );
    expect(
      createMarkdownParser({ linkify: false }).render("see https://paseo.sh now"),
    ).not.toContain("href");
  });
});

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
}

describe("Swarm envelope reference fields", () => {
  function links(kind: SwarmEnvelope["kind"], source: string) {
    return createSwarmEnvelopeMarkdownParser(kind)
      .parse(source, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === "link_open")
      .map((token) => ({
        href: token.attrGet("href"),
        generated: token.attrGet("data-swarm-envelope-reference") === "true",
      }));
  }

  it.each(["\n", "\r\n"])("links only exact team fields with %j line endings", (newline) => {
    const source = [
      "Task: ui-task-9.",
      "Team message from root.supervisor.worker-2 to root.supervisor:",
      "Recipient: root.supervisor.",
      "Ordinary mention of root.supervisor and ui-task-9.",
    ].join(newline);
    expect(links("team", source)).toEqual([
      { href: "paseo-swarm://task/ui-task-9", generated: true },
      { href: "paseo-swarm://agent/root.supervisor.worker-2", generated: true },
      { href: "paseo-swarm://agent/root.supervisor", generated: true },
      { href: "paseo-swarm://agent/root.supervisor", generated: true },
    ]);
  });

  it("uses capture boundaries even when names equal the field's prose", () => {
    const parser = createSwarmEnvelopeMarkdownParser("team");
    const source = "Team message message-12 from message:\nRecipient: recipient.";
    expect(parser.render(source)).toContain(
      'Team message message-12 from <a href="paseo-swarm://agent/message"',
    );
    expect(links("team", source)).toEqual([
      { href: "paseo-swarm://agent/message", generated: true },
      { href: "paseo-swarm://agent/recipient", generated: true },
    ]);
  });

  it.each(["completed", "canceled", "failed"] as const)(
    "links the actual digest agent for %s without linking report or Task text",
    (outcome) => {
      const digest = turnDigest({
        manager: "planner.supervisor",
        rows: [
          turnDigestRow({
            agent: "planner.supervisor.worker-2",
            occupant: 1,
            taskId: "ui-task-9",
            outcome,
            detail: "stopped",
            report: "Task names in ordinary reports stay text.\nTask: other-task.",
            filesChanged: 1,
          }),
        ],
      });
      const envelope = parseSwarmEnvelope(digest);
      if (!envelope) throw new Error("Expected actual runtime envelope");
      expect(links(envelope.kind, envelope.body)).toEqual([
        { href: "paseo-swarm://agent/planner.supervisor.worker-2", generated: true },
      ]);
    },
  );

  it("links the actual team producer fields while preserving the source and rendered text tokens", () => {
    const notification = messagePrompt({
      sender: "planner.supervisor.worker",
      recipient: "planner.supervisor",
      taskId: "ui-task-9",
      message: "中文😀 (c) a -- b",
    });
    const envelope = parseSwarmEnvelope(notification);
    if (!envelope) throw new Error("Expected actual team envelope");
    const parser = createSwarmEnvelopeMarkdownParser(envelope.kind);
    const original = createMarkdownParser({ linkify: false });
    const textTokens = (markdown: ReturnType<typeof createMarkdownParser>) =>
      markdown
        .parse(envelope.body, {})
        .flatMap((token) => token.children ?? [])
        .filter((token) => token.type !== "link_open" && token.type !== "link_close")
        .map((token) => token.content)
        .join("");
    expect(textTokens(parser)).toBe(textTokens(original));
    expect(links(envelope.kind, envelope.body)).toEqual([
      { href: "paseo-swarm://task/ui-task-9", generated: true },
      { href: "paseo-swarm://agent/planner.supervisor.worker", generated: true },
      { href: "paseo-swarm://agent/planner.supervisor", generated: true },
      { href: "paseo-swarm://agent/planner.supervisor", generated: true },
    ]);
    expect(notification).toContain("中文😀 (c) a -- b");
    expect(notification).not.toContain("paseo-swarm://");
  });

  it.each([
    "Task: none specified.",
    "Task: none.",
    "Task: UI-task.",
    "Task: path/escape.",
    "Task: bad%2Fid.",
    "Task: bad?id.",
    "Task: bad#id.",
    "Task: 中文😀.",
    "Recipient: ../worker.",
    "Recipient: root..worker.",
    "Recipient: root_worker.",
    "See Task: task-9.",
    "Agent worker ran a task.",
    "Manager worker must do something else.",
  ])("leaves unsupported or ordinary text alone: %s", (source) => {
    expect(links("team", source)).toEqual([]);
    expect(links("runtime", source)).toEqual([]);
  });

  it.each([
    "`Task: task-9.`",
    "    Task: task-9.",
    "```text\nTask: task-9.\nRecipient: root.worker.\n```",
    "> Task: task-9.\n> Recipient: root.worker.",
    "![Task: task-9.](https://example.test/image.png)",
    "Task: `task-9`.",
    "**Task: task-9.**",
  ])("does not add links inside code, quotes, images or formatted fields: %s", (source) => {
    expect(links("team", source)).toEqual([]);
  });

  it("preserves existing explicit links and never nests a generated link", () => {
    const source =
      "[Task: task-9.](paseo-swarm://task/already)\nRecipient: [root.worker](paseo-swarm://agent/root.worker).\n[external](https://example.test)";
    expect(links("team", source)).toEqual([
      { href: "paseo-swarm://task/already", generated: false },
      { href: "paseo-swarm://agent/root.worker", generated: false },
      { href: "https://example.test", generated: false },
    ]);
  });

  it("keeps runtime report Task text plain and existing canonical Markdown active", () => {
    const source = "Task: task-9.\n[Task](paseo-swarm://task/task-9)";
    expect(links("runtime", source)).toEqual([
      { href: "paseo-swarm://task/task-9", generated: false },
    ]);
  });

  it("does not automatically link settings or bare URLs", () => {
    const source = "Task: task-9.\nRecipient: root.worker.\nhttps://example.test";
    expect(links("settings", source)).toEqual([]);
    expect(links("team", "https://example.test")).toEqual([]);
  });
});
