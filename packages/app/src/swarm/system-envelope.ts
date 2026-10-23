export interface SwarmEnvelope {
  kind: "settings" | "team" | "runtime";
  body: string;
}

const tags = [
  { kind: "settings", tag: "paseo-swarm-system-settings" },
  { kind: "team", tag: "paseo-swarm-team-message" },
  { kind: "runtime", tag: "paseo-swarm-turn-digest" },
  // Runtime notices from Swarm before turn digests; still in older transcripts.
  { kind: "runtime", tag: "paseo-swarm-runtime-notification" },
] as const;

// Data-only envelopes carry their fields as name="value" attributes on the opening tag.
const attributePattern = /\s+([a-z][a-z0-9-]*)="([^"\r\n]*)"/gy;

function decode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

interface Opening {
  length: number;
  attributes: Map<string, string>;
  selfClosing: boolean;
}

// Reads `<tag a="1" b="2">` (or `... />`) at offset: its attributes and where it ends.
function readOpening(text: string, tag: string, offset = 0): Opening | null {
  const prefix = `<${tag}`;
  if (!text.startsWith(prefix, offset)) return null;
  const attributes = new Map<string, string>();
  attributePattern.lastIndex = offset + prefix.length;
  let end = offset + prefix.length;
  for (let match = attributePattern.exec(text); match; match = attributePattern.exec(text)) {
    attributes.set(match[1], decode(match[2]));
    end = attributePattern.lastIndex;
  }
  if (text[end] === ">") return { length: end + 1 - offset, attributes, selfClosing: false };
  const selfClosing = /^\s*\/>/.exec(text.slice(end, end + 8));
  if (!selfClosing) return null;
  return { length: end + selfClosing[0].length - offset, attributes, selfClosing: true };
}

function label(name: string): string {
  const words = name.replaceAll("-", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The field lines the envelope markdown parser links, followed by the sender's words.
function teamBody(attributes: Map<string, string>, body: string): string {
  const { id, from, to, task, ...rest } = Object.fromEntries(attributes);
  const lines = [
    task ? `Task: ${task}.` : "",
    id ? `Team message ${id} from ${from}:` : `Team message from ${from} to ${to}:`,
    to ? `Recipient: ${to}.` : "",
    ...Object.entries(rest).map(([name, value]) => `${label(name)}: ${value}.`),
  ].filter(Boolean);
  return `${lines.join("\n")}\n\n${body}`;
}

interface TurnRow {
  attributes: Map<string, string>;
  report: string;
}

// Rows are `<turn ... />` or `<turn ...>\nreport\n</turn>`, one after another.
function turnRows(body: string): TurnRow[] | null {
  const rows: TurnRow[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const opening = readOpening(body, "turn", cursor);
    if (!opening) return null;
    cursor += opening.length;
    if (opening.selfClosing) {
      rows.push({ attributes: opening.attributes, report: "" });
    } else {
      if (body[cursor] !== "\n") return null;
      const start = cursor + 1;
      // A report may quote </turn>; a row ends at one followed by the next row or the end.
      let close = body.indexOf("\n</turn>", start);
      while (close !== -1) {
        const after = close + "\n</turn>".length;
        if (after === body.length || body.startsWith("\n<turn", after)) break;
        close = body.indexOf("\n</turn>", after);
      }
      if (close === -1) return null;
      rows.push({ attributes: opening.attributes, report: body.slice(start, close) });
      cursor = close + "\n</turn>".length;
    }
    if (cursor < body.length) {
      if (body[cursor] !== "\n") return null;
      cursor += 1;
    }
  }
  return rows;
}

function digestBody(body: string): string {
  const rows = turnRows(body);
  if (!rows) return body;
  return rows
    .map(({ attributes, report }) => {
      const agent = attributes.get("agent");
      const task = attributes.get("task");
      const detail = attributes.get("detail");
      const files = attributes.get("files");
      const lines = [
        `Agent ${agent} turn ended with runtime outcome: ${attributes.get("outcome")}.`,
        task ? `Task: ${task}.` : "",
        detail ? `Detail: ${detail}` : "",
        files && files !== "0" ? `Files changed: ${files}.` : "",
      ].filter(Boolean);
      const truncated = attributes.get("truncated") === "true" ? "\n\n(Report truncated.)" : "";
      return report ? `${lines.join("\n")}\n\n${report}${truncated}` : lines.join("\n");
    })
    .join("\n\n---\n\n");
}

export function parseSwarmEnvelope(text: string): SwarmEnvelope | null {
  for (const { kind, tag } of tags) {
    const opening = readOpening(text, tag);
    if (!opening) continue;
    if (opening.selfClosing) return null;
    const newline = text.startsWith("\r\n", opening.length) ? "\r\n" : "\n";
    if (!text.startsWith(newline, opening.length)) return null;
    const bodyStart = opening.length + newline.length;
    const closingTag = `</${tag}>`;
    const delimiter = newline + closingTag;

    if (kind === "settings") {
      if (opening.attributes.size > 0) return null;
      // Settings are a prefix; the project, role and orientation follow this block.
      const closing = new RegExp(`${delimiter}(?=\\r?\\n|$)`).exec(text.slice(opening.length));
      if (!closing) return null;
      const closingOffset = opening.length + closing.index;
      return {
        kind,
        body:
          text.slice(bodyStart, Math.max(bodyStart, closingOffset)) +
          text.slice(closingOffset + closing[0].length),
      };
    }

    // Match the opening newline exactly: an LF frame may end its body with CR.
    // Nested tags remain opaque; concatenated messages may share one display card.
    if (!text.endsWith(delimiter)) return null;
    const bodyEnd = text.length - delimiter.length;
    if (bodyEnd < opening.length) return null;
    const body = text.slice(bodyStart, Math.max(bodyStart, bodyEnd));
    if (opening.attributes.size === 0) return { kind, body };
    if (tag === "paseo-swarm-team-message") {
      return { kind, body: teamBody(opening.attributes, body) };
    }
    return { kind, body: digestBody(body) };
  }
  return null;
}
