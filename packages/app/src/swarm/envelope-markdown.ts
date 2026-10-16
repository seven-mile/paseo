import { createMarkdownParser } from "@/utils/markdown-parser";
import type { SwarmEnvelope } from "./system-envelope";

const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
const agent = `${slug}(?:\\.${slug})*`;
const teamFields = [
  { pattern: new RegExp(`^(Task: )(${slug})(\\.)$`), kind: "task" },
  { pattern: new RegExp(`^(Team message from )(${agent})( to )(${agent})(:)$`), kind: "agent" },
  { pattern: new RegExp(`^(Team message ${slug} from )(${agent})(:)$`), kind: "agent" },
  { pattern: new RegExp(`^(Recipient: )(${agent})(\\.)$`), kind: "agent" },
] as const;
const runtimeFields = [
  {
    pattern: new RegExp(
      `^(Agent )(${agent})( turn ended with runtime outcome: (?:completed|canceled|failed)\\.)$`,
    ),
    kind: "agent",
  },
  { pattern: new RegExp(`^(Agent )(${agent})( is (?:idle|inactive)\\.)$`), kind: "agent" },
  {
    pattern: new RegExp(
      `^(Manager )(${agent})( must evaluate the next business step from the available evidence and PWA, send a next instruction when the agent should continue, and continue coordinating until genuinely blocked or completed\\.)$`,
    ),
    kind: "agent",
  },
] as const;

export function createSwarmEnvelopeMarkdownParser(kind: SwarmEnvelope["kind"]) {
  const parser = createMarkdownParser({ linkify: false });
  if (kind === "settings") return parser;
  const fields = kind === "team" ? teamFields : runtimeFields;
  parser.core.ruler.after("inline", "swarm_envelope_fields", (state) => {
    let quoteDepth = 0;
    for (const block of state.tokens) {
      if (block.type === "blockquote_open") quoteDepth += 1;
      if (block.type === "blockquote_close") quoteDepth -= 1;
      if (quoteDepth !== 0) continue;
      if (block.type !== "inline" || !block.children) continue;
      let lineStart = true;
      let linkDepth = 0;
      block.children = block.children.flatMap((token) => {
        const atLineStart = lineStart;
        lineStart = token.type === "softbreak" || token.type === "hardbreak";
        if (token.type === "link_open") linkDepth += 1;
        if (token.type === "link_close") linkDepth -= 1;
        if (!atLineStart || linkDepth !== 0 || token.type !== "text") return [token];
        for (const field of fields) {
          const match = field.pattern.exec(token.content);
          if (!match) continue;
          if (field.kind === "task" && match[2] === "none") return [token];
          return match.slice(1).flatMap((content, index) => {
            const text = new state.Token("text", "", 0);
            text.content = content;
            if (index % 2 === 0) return [text];
            const open = new state.Token("link_open", "a", 1);
            open.attrSet("href", `paseo-swarm://${field.kind}/${encodeURIComponent(content)}`);
            open.attrSet("data-swarm-envelope-reference", "true");
            return [open, text, new state.Token("link_close", "a", -1)];
          });
        }
        return [token];
      });
    }
  });
  return parser;
}
