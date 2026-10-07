import { z } from "zod";

export const activityRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("agent"),
    uri: z.string(),
    label: z.string(),
    qualifiedName: z.string(),
    paseoAgentId: z.string(),
    workspaceId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("workspace"),
    uri: z.string(),
    label: z.string(),
    workspaceId: z.string(),
  }),
  z.object({
    kind: z.literal("task"),
    uri: z.string(),
    label: z.string(),
    taskId: z.string(),
  }),
  z.object({
    kind: z.literal("file"),
    uri: z.string(),
    label: z.string(),
    workspaceId: z.string(),
    path: z.string(),
  }),
]);
export type ActivityRef = z.infer<typeof activityRefSchema>;

export type SwarmRefTarget =
  | { kind: "agent"; qualifiedName: string }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "task"; taskId: string }
  | { kind: "file"; workspaceId: string; path: string };

export interface InlineSwarmLink {
  label: string;
  uri: string;
}
export type MarkdownPart =
  | { kind: "text"; text: string }
  | { kind: "ref"; label: string; uri: string };

const inlineLinkPattern = /\[([^\]\n]+)\]\((paseo-swarm:\/\/[^)\s]+)\)/g;

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

function encodedSegments(uri: string): { host: string; segments: string[] } | null {
  const match = /^paseo-swarm:\/\/([^/?#]+)\/([^?#]+)$/.exec(uri);
  if (!match) return null;
  const segments = match[2].split("/").map(decodeSegment);
  if (segments.some((segment) => segment === null)) return null;
  return { host: match[1].toLowerCase(), segments: segments as string[] };
}

export function parseSwarmUri(uri: string): SwarmRefTarget | null {
  const parsed = encodedSegments(uri);
  if (!parsed) return null;
  const { host, segments } = parsed;
  if (host === "agent" && segments.length === 1) {
    return { kind: "agent", qualifiedName: segments[0] };
  }
  if (host === "workspace" && segments.length === 1) {
    return { kind: "workspace", workspaceId: segments[0] };
  }
  if (host === "task" && segments.length === 1) {
    return { kind: "task", taskId: segments[0] };
  }
  if (host === "file" && segments.length >= 2) {
    const path = segments.slice(1).join("/");
    if (path.startsWith("/") || path.split("/").some((part) => part === ".." || part === ".")) {
      return null;
    }
    return { kind: "file", workspaceId: segments[0], path };
  }
  return null;
}

export function formatSwarmUri(target: SwarmRefTarget): string {
  const encode = (value: string) => encodeURIComponent(value);
  switch (target.kind) {
    case "agent":
      return `paseo-swarm://agent/${encode(target.qualifiedName)}`;
    case "workspace":
      return `paseo-swarm://workspace/${encode(target.workspaceId)}`;
    case "task":
      return `paseo-swarm://task/${encode(target.taskId)}`;
    case "file":
      return `paseo-swarm://file/${encode(target.workspaceId)}/${target.path
        .split("/")
        .map(encode)
        .join("/")}`;
  }
}

export function extractInlineSwarmLinks(markdown: string): InlineSwarmLink[] {
  const links: InlineSwarmLink[] = [];
  for (const match of markdown.matchAll(inlineLinkPattern)) {
    links.push({ label: match[1], uri: match[2] });
  }
  return links;
}

export function splitMarkdownParts(markdown: string): MarkdownPart[] {
  const parts: MarkdownPart[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(inlineLinkPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ kind: "text", text: markdown.slice(cursor, index) });
    parts.push({ kind: "ref", label: match[1], uri: match[2] });
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) parts.push({ kind: "text", text: markdown.slice(cursor) });
  return parts.length > 0 ? parts : [{ kind: "text", text: markdown }];
}
