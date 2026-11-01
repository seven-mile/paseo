import { resolveWorkspaceFilePaths, type WorkspaceFileLocation } from "@/workspace/file-open";

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINE_FRAGMENT = /^L(\d+)(?:-L?(\d+))?$/;

// A relative link in a Markdown file names a file next to that document, as it does on a forge.
// Returns the workspace file it opens, or null for links the renderer handles itself: anchors,
// URLs with a scheme, root-relative and protocol-relative paths, and targets outside the
// workspace.
export function resolveMarkdownFileLink(input: {
  href: string;
  documentPath: string;
  workspaceRoot: string;
}): WorkspaceFileLocation | null {
  const href = splitHref(input.href);
  if (!href) return null;
  const document = resolveWorkspaceFilePaths({
    path: input.documentPath,
    workspaceRoot: input.workspaceRoot,
  })?.relativePath;
  if (!document) return null;
  const path = joinWithinRoot(document.split("/").slice(0, -1), href.path);
  return path ? { path, ...lineRange(href.fragment) } : null;
}

function splitHref(raw: string): { path: string; fragment: string } | null {
  const href = raw.trim();
  if (!href || href.startsWith("#") || href.startsWith("/") || SCHEME.test(href)) return null;
  const [beforeFragment, ...fragment] = href.split("#");
  const encoded = beforeFragment.split("?")[0];
  if (!encoded) return null;
  try {
    return { path: decodeURIComponent(encoded).replace(/\\/g, "/"), fragment: fragment.join("#") };
  } catch {
    return null;
  }
}

// Null when the path leaves the workspace root or names the root itself.
function joinWithinRoot(base: string[], path: string): string | null {
  const segments = [...base];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment !== "..") segments.push(segment);
    else if (segments.pop() === undefined) return null;
  }
  return segments.length > 0 ? segments.join("/") : null;
}

function lineRange(fragment: string): Pick<WorkspaceFileLocation, "lineStart" | "lineEnd"> {
  const lines = LINE_FRAGMENT.exec(fragment);
  const lineStart = lines ? Number(lines[1]) : 0;
  if (!lines || lineStart < 1) return {};
  const lineEnd = lines[2] ? Number(lines[2]) : undefined;
  return lineEnd && lineEnd >= lineStart ? { lineStart, lineEnd } : { lineStart };
}
