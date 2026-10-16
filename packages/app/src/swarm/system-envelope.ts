export interface SwarmEnvelope {
  kind: "settings" | "team" | "runtime";
  body: string;
}

const tags = [
  { kind: "settings", tag: "paseo-swarm-system-settings" },
  { kind: "team", tag: "paseo-swarm-team-message" },
  { kind: "runtime", tag: "paseo-swarm-runtime-notification" },
] as const;

export function parseSwarmEnvelope(text: string): SwarmEnvelope | null {
  for (const { kind, tag } of tags) {
    const openingTag = `<${tag}>`;
    if (!text.startsWith(openingTag)) continue;
    const newline = text.startsWith(`${openingTag}\r\n`) ? "\r\n" : "\n";
    if (!text.startsWith(openingTag + newline)) return null;
    const bodyStart = openingTag.length + newline.length;
    const closingTag = `</${tag}>`;
    const delimiter = newline + closingTag;

    if (kind === "settings") {
      // Settings are a prefix; the project, role and orientation follow this block.
      const closing = new RegExp(`${delimiter}(?=\\r?\\n|$)`).exec(text.slice(openingTag.length));
      if (!closing) return null;
      const closingOffset = openingTag.length + closing.index;
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
    if (bodyEnd < openingTag.length) return null;
    return { kind, body: text.slice(bodyStart, Math.max(bodyStart, bodyEnd)) };
  }
  return null;
}
