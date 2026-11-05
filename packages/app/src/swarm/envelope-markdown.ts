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

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}>/;

/**
 * Links the Task and agent names in a team or runtime envelope's fixed field lines to the Swarm
 * references they name. Only whole lines match, outside fences and quotes, so text an agent quoted
 * or wrote in a code block stays as written.
 */
export function linkSwarmEnvelopeFields(kind: SwarmEnvelope["kind"], body: string): string {
  if (kind !== "team" && kind !== "runtime") return body;
  const fields = kind === "team" ? teamFields : runtimeFields;
  let fence: string | null = null;
  return body
    .split(/(\r?\n)/)
    .map((line, index) => {
      if (index % 2 === 1) return line;
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      if (QUOTE.test(line)) return line;
      for (const field of fields) {
        const match = field.pattern.exec(line);
        if (!match) continue;
        if (field.kind === "task" && match[2] === "none") return line;
        return match
          .slice(1)
          .map((content, part) =>
            part % 2 === 0
              ? content
              : `[${content}](paseo-swarm://${field.kind}/${encodeURIComponent(content)})`,
          )
          .join("");
      }
      return line;
    })
    .join("");
}
