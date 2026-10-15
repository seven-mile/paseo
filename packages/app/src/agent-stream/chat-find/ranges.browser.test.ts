import { afterEach, expect, it } from "vitest";
import { findMessageMatches, findRenderedMatches } from "./ranges.web";

afterEach(() => {
  document.body.replaceChildren();
});
function content(html: string) {
  const row = document.createElement("div");
  row.innerHTML = `<div data-message-text="true">${html}</div>`;
  document.body.append(row);
  return row;
}
function message(messageId: string, ...blocks: string[]) {
  const root = document.createElement("div");
  for (const block of blocks) {
    const row = document.createElement("div");
    row.dataset.messageId = messageId;
    row.innerHTML = `<div data-message-text="true"><div data-paseo-markdown-tag="p">${block}</div></div>`;
    root.append(row);
  }
  document.body.append(root);
  return root;
}
it("collects a message's occurrences across its block rows in row order", () => {
  const root = message("message-1", "alpha one", "beta", "alpha two");
  const other = document.createElement("div");
  other.dataset.messageId = "message-2";
  other.innerHTML =
    '<div data-message-text="true"><div data-paseo-markdown-tag="p">alpha three</div></div>';
  root.append(other);
  expect(findMessageMatches(root, "message-1", "alpha").map((range) => range.toString())).toEqual([
    "alpha",
    "alpha",
  ]);
  expect(
    findMessageMatches(root, "message-1", "alpha").map(
      (range) => range.startContainer.parentElement?.textContent,
    ),
  ).toEqual(["alpha one", "alpha two"]);
  expect(findMessageMatches(root, "message-2", "alpha")).toHaveLength(1);
  expect(findMessageMatches(null, "message-1", "alpha")).toEqual([]);
});
it("finds each actual occurrence across inline formatting with original Unicode offsets", () => {
  const row = content(
    '<div data-paseo-markdown-tag="p">İ😀hello <strong>world</strong> then <em>hello</em> world</div>',
  );
  const matches = findRenderedMatches(row, "hello world");
  expect(matches.map((range) => range.toString())).toEqual(["hello world", "hello world"]);
  expect(matches[0]!.startOffset).toBe(3);
  expect(matches[0]!.compareBoundaryPoints(Range.START_TO_START, matches[1]!)).toBe(-1);
});
it("ignores controls, keeps block boundaries, and preserves literal code punctuation", () => {
  const row = content(
    '<div data-paseo-markdown-tag="p">first</div><div data-paseo-markdown-tag="p">second</div><div data-paseo-markdown-tag="pre"><span>const a</span><span>.b</span><button>copy a.b</button><span data-paseo-markdown-ignore="true">a.b</span></div>',
  );
  expect(findRenderedMatches(row, "firstsecond")).toEqual([]);
  expect(findRenderedMatches(row, "a.b").map((range) => range.toString())).toEqual(["a.b"]);
});
it("matches whitespace across text nodes without inspecting hidden link destinations", () => {
  const row = content(
    '<div data-paseo-markdown-tag="p"><a href="https://example.com/hidden">hello &amp; world</a>\nline</div>',
  );
  expect(findRenderedMatches(row, "hidden")).toEqual([]);
  expect(findRenderedMatches(row, "world line").map((range) => range.toString())).toEqual([
    "world\nline",
  ]);
});

it("finds an envelope body inside one marker without counting its controls or original disclosure", () => {
  const root = document.createElement("div");
  const row = document.createElement("div");
  row.dataset.messageId = "envelope-message";
  row.innerHTML =
    '<div data-message-text="true"><div><button>find body</button><div data-card-body="true">İ😀find <strong>body</strong></div></div></div><button>Original message</button>';
  root.append(row);
  document.body.append(root);

  const matches = () => findMessageMatches(root, "envelope-message", "find body");
  expect(row.querySelectorAll('[data-message-text="true"]')).toHaveLength(1);
  expect(matches().map((range) => range.toString())).toEqual(["find body"]);
  expect(matches()[0]!.startOffset).toBe(3);
  expect(matches()[0]!.startContainer.parentElement?.dataset.cardBody).toBe("true");
  expect(findRenderedMatches(row, "Original message")).toEqual([]);

  const original = document.createElement("div");
  original.textContent =
    "<paseo-swarm-team-message>\nİ😀find **body**\n</paseo-swarm-team-message>";
  row.append(original);
  expect(findMessageMatches(root, "envelope-message", "paseo-swarm-team-message")).toEqual([]);
  expect(findRenderedMatches(row, "paseo-swarm-team-message")).toEqual([]);
  expect(matches().map((range) => range.toString())).toEqual(["find body"]);
  expect(findMessageMatches(root, "envelope-message", "İ😀find")).toHaveLength(1);

  row.querySelector('[data-card-body="true"]')!.remove();
  expect(matches()).toEqual([]);
  expect(findMessageMatches(root, "envelope-message", "İ😀find")).toEqual([]);
});

it("keeps Task and agent link text searchable across field boundaries without raw duplicates", () => {
  const root = document.createElement("div");
  const row = document.createElement("div");
  row.dataset.messageId = "linked-envelope-message";
  row.innerHTML =
    '<div data-message-text="true"><div data-paseo-markdown-tag="p">İ😀Task: <div role="link"><span data-reference="task">task-id</span></div>.</div><div data-paseo-markdown-tag="p">Agent <div role="link"><span data-reference="agent">planner.worker</span></div> is idle.</div></div><button>Original message</button>';
  root.append(row);
  document.body.append(root);
  const taskText = row.querySelector('[data-reference="task"]')!.firstChild;
  const agentText = row.querySelector('[data-reference="agent"]')!.firstChild;
  const matches = (query: string) => findMessageMatches(root, "linked-envelope-message", query);
  const task = matches("task-id");
  expect(task.map((range) => range.toString())).toEqual(["task-id"]);
  expect(task[0]!.startContainer).toBe(taskText);
  expect(task[0]!.startOffset).toBe(0);
  const crossField = matches("Task: task-id");
  expect(crossField.map((range) => range.toString())).toEqual(["Task: task-id"]);
  expect(crossField[0]!.startOffset).toBe(3);
  expect(crossField[0]!.endContainer).toBe(taskText);
  expect(crossField[0]!.endOffset).toBe(7);
  const agent = matches("planner.worker");
  expect(agent.map((range) => range.toString())).toEqual(["planner.worker"]);
  expect(agent[0]!.startContainer).toBe(agentText);
  expect(agent[0]!.startOffset).toBe(0);

  const original = document.createElement("div");
  original.textContent =
    "<paseo-swarm-team-message>\nİ😀Task: task-id.\nAgent planner.worker is idle.\n</paseo-swarm-team-message>";
  row.append(original);
  expect(matches("task-id").map((range) => range.toString())).toEqual(["task-id"]);
  expect(matches("Task: task-id").map((range) => range.toString())).toEqual(["Task: task-id"]);
  expect(matches("planner.worker").map((range) => range.toString())).toEqual(["planner.worker"]);
  expect(findRenderedMatches(row, "Original message")).toEqual([]);
  row.querySelector('[data-message-text="true"]')!.remove();
  expect(matches("task-id")).toEqual([]);
  expect(matches("Task: task-id")).toEqual([]);
  expect(matches("planner.worker")).toEqual([]);
});
