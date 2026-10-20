import { createHash } from "node:crypto";
import { type Dir, type Dirent, opendirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { parse } from "yaml";

export type RoleClass = "planner" | "supervisor" | "worker";

export interface Pwa {
  project: string;
  role: string;
  roleClass: RoleClass;
  projectBody: string;
  roleBody: string;
  statuses: string[];
  revision: string;
}

export interface PwaRole {
  role: string;
  roleClass: RoleClass;
  title: string;
  description: string;
}

interface Document {
  data: unknown;
  body: string;
}

interface Header {
  data: Record<string, unknown>;
  source: string;
  body: string;
  project: string;
  statuses: string[];
}

interface Entry extends Header {
  roles: Record<string, string>;
}

interface RoleDocument extends PwaRole {
  source: string;
}

export interface PwaDiscoveryEntry {
  directory: string;
  title: string;
  roles: PwaRole[];
  statuses: string[];
  error?: string;
}

export interface PwaDiscoveryError {
  directory: string;
  error: string;
}

export interface PwaDiscovery {
  entries: PwaDiscoveryEntry[];
  complete: boolean;
  errors: PwaDiscoveryError[];
  rootError?: string;
}

interface PendingDirectory {
  path: string;
  depth: number;
}

interface DiscoveryLimits {
  maxDepth?: number;
  maxDirectories?: number;
  maxEntries?: number;
  maxPwas?: number;
  maxMilliseconds?: number;
}

function document(source: string, name: string): Document {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) throw new Error(`${name} must have YAML frontmatter`);
  let data: unknown;
  try {
    data = parse(match[1]);
  } catch (error) {
    throw new Error(`Malformed YAML frontmatter in ${name}`, { cause: error });
  }
  return { data, body: source.slice(match[0].length).trim() };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} frontmatter must be a YAML mapping`);
  }
  return Object.fromEntries(Object.entries(value));
}

function requiredString(value: unknown, field: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} frontmatter field ${field} must be a non-empty string`);
  }
  return value;
}

function validateRole(role: string): void {
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(role)) {
    throw new Error(`Invalid role slug: ${role}`);
  }
}

function assertWithin(root: string, path: string): void {
  const child = relative(root, path);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`PWA path is outside content root: ${path}`);
  }
}

export function resolvePwaDirectory(directory: string, contentRoot: string): string {
  const root = realpathSync(contentRoot);
  if (!statSync(root).isDirectory()) throw new Error(`Not a PWA content directory: ${root}`);
  const path = resolve(root, directory);
  assertWithin(root, path);
  const canonical = realpathSync(path);
  assertWithin(root, canonical);
  if (!statSync(canonical).isDirectory()) throw new Error(`Not a PWA directory: ${canonical}`);
  return canonical;
}

function readHeader(directory: string, contentRoot: string): Header {
  const canonical = resolvePwaDirectory(directory, contentRoot);
  const path = realpathSync(join(canonical, "PWA.md"));
  assertWithin(realpathSync(contentRoot), path);
  const source = readFileSync(path, "utf8");
  const parsed = document(source, "PWA.md");
  const data = record(parsed.data, "PWA.md");
  if (data.version !== 1) throw new Error("PWA.md frontmatter version must be 1");
  const project = requiredString(data.project, "project", "PWA.md");
  const statuses = data.statuses === undefined ? [] : data.statuses;
  if (!Array.isArray(statuses) || statuses.some((status) => typeof status !== "string")) {
    throw new Error("PWA.md frontmatter field statuses must be an array of strings");
  }
  return { data, source, body: parsed.body, project, statuses: [...statuses] };
}

function readEntry(directory: string, contentRoot: string, visit?: () => void): Entry {
  const header = readHeader(directory, contentRoot);
  const canonical = resolvePwaDirectory(directory, contentRoot);
  const rolesDirectory = realpathSync(join(canonical, "roles"));
  assertWithin(realpathSync(contentRoot), rolesDirectory);
  const roles: Record<string, string> = {};
  const stream = opendirSync(rolesDirectory);
  try {
    let entry: Dirent | null;
    while ((entry = stream.readSync()) !== null) {
      visit?.();
      if ((!entry.isFile() && !entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
      const role = entry.name.slice(0, -3);
      validateRole(role);
      roles[role] = join("roles", entry.name);
    }
  } finally {
    stream.closeSync();
  }
  return { ...header, roles };
}

function readRole(
  directory: string,
  role: string,
  path: string,
  contentRoot: string,
): RoleDocument {
  const canonical = resolvePwaDirectory(directory, contentRoot);
  const rolePath = realpathSync(resolve(canonical, path));
  assertWithin(realpathSync(contentRoot), rolePath);
  const source = readFileSync(rolePath, "utf8");
  const parsed = document(source, path);
  const data = record(parsed.data, path);
  if (data.version !== 1) throw new Error(`${path} frontmatter version must be 1`);
  const roleClass = data.roleClass;
  if (roleClass !== "planner" && roleClass !== "supervisor" && roleClass !== "worker") {
    throw new Error(`${path} frontmatter roleClass is invalid`);
  }
  const title = data.title === undefined ? role : requiredString(data.title, "title", path);
  return { source, role, roleClass, title, description: parsed.body };
}

export function readPwa(directory: string, role: string, contentRoot = directory): Pwa {
  validateRole(role);
  const entry = readEntry(directory, contentRoot);
  const path = entry.roles[role];
  if (!Object.hasOwn(entry.roles, role))
    throw new Error(`Missing role: ${role} in roles directory`);
  const selected = readRole(directory, role, path, contentRoot);
  const revision = createHash("sha256")
    .update(entry.source)
    .update("\0")
    .update(selected.source)
    .digest("hex");
  return {
    project: entry.project,
    role,
    roleClass: selected.roleClass,
    projectBody: entry.body,
    roleBody: selected.description,
    statuses: entry.statuses,
    revision,
  };
}

export function listPwaRoles(directory: string, contentRoot = directory): PwaRole[] {
  return readRoles(directory, contentRoot);
}

function readRoles(directory: string, contentRoot: string, visit?: () => void): PwaRole[] {
  const entry = readEntry(directory, contentRoot, visit);
  return Object.entries(entry.roles)
    .map(([role, path]) => {
      visit?.();
      const selected = readRole(directory, role, path, contentRoot);
      return {
        role,
        roleClass: selected.roleClass,
        title: selected.title,
        description: selected.description,
      };
    })
    .sort((left, right) => left.role.localeCompare(right.role));
}

export function readPwaStatuses(directory: string, contentRoot = directory): string[] {
  return readHeader(directory, contentRoot).statuses;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function discoverPwas(contentRoot: string, limits: DiscoveryLimits = {}): PwaDiscovery {
  const result: PwaDiscovery = { entries: [], complete: true, errors: [] };
  const started = performance.now();
  const maxDepth = limits.maxDepth ?? 8;
  const maxDirectories = limits.maxDirectories ?? 1024;
  const maxEntries = limits.maxEntries ?? 10000;
  const maxPwas = limits.maxPwas ?? 256;
  const maxMilliseconds = limits.maxMilliseconds ?? 100;
  let root: string;
  try {
    root = realpathSync(contentRoot);
    if (!statSync(root).isDirectory()) throw new Error(`Not a PWA content directory: ${root}`);
  } catch (error) {
    return { ...result, complete: false, rootError: errorMessage(error) };
  }
  const pending = [{ path: root, depth: 0 }];
  let directories = 0;
  let entries = 0;
  function incomplete(directory: string, error: string) {
    result.complete = false;
    result.errors.push({ directory, error });
  }
  function found(directory: string, path: string) {
    let title = directory;
    let statuses: string[] = [];
    try {
      const entry = readHeader(path, root);
      title = entry.project;
      statuses = entry.statuses;
      const roles = readRoles(path, root, () => {
        entries++;
        if (entries > maxEntries || performance.now() - started >= maxMilliseconds) {
          incomplete(directory, "PWA discovery role limit reached");
          pending.length = 0;
          throw new Error("PWA discovery role limit reached");
        }
      });
      if (!roles.some((role) => role.roleClass === "planner")) {
        throw new Error("PWA must declare a planner role");
      }
      result.entries.push({ directory, title: entry.project, roles, statuses: entry.statuses });
    } catch (error) {
      result.entries.push({ directory, title, roles: [], statuses, error: errorMessage(error) });
    }
  }
  function childEntry(child: Dirent, next: PendingDirectory, directory: string): boolean {
    if (child.name === "PWA.md" && !child.isDirectory()) {
      if (result.entries.length >= maxPwas) {
        incomplete(directory, "PWA discovery PWA limit reached");
        pending.length = 0;
        return false;
      }
      found(directory, next.path);
    }
    if (!child.isDirectory() || child.name.startsWith(".") || child.name === "node_modules")
      return true;
    if (next.depth >= maxDepth) {
      incomplete(relative(root, join(next.path, child.name)), "PWA discovery depth limit reached");
      return true;
    }
    if (pending.length >= maxDirectories) {
      incomplete(directory, "PWA discovery directory limit reached");
      return true;
    }
    pending.push({ path: join(next.path, child.name), depth: next.depth + 1 });
    return true;
  }
  function scan(next: PendingDirectory, directory: string) {
    let stream: Dir;
    try {
      stream = opendirSync(next.path);
    } catch (error) {
      if (next.depth === 0) result.rootError = errorMessage(error);
      incomplete(directory, errorMessage(error));
      return;
    }
    try {
      let child: Dirent | null;
      while ((child = stream.readSync()) !== null) {
        entries++;
        if (entries > maxEntries || performance.now() - started >= maxMilliseconds) {
          incomplete(directory, "PWA discovery limit reached");
          pending.length = 0;
          break;
        }
        if (!childEntry(child, next, directory)) break;
      }
    } catch (error) {
      if (next.depth === 0) result.rootError = errorMessage(error);
      incomplete(directory, errorMessage(error));
    } finally {
      stream.closeSync();
    }
  }
  while (pending.length) {
    const next = pending.shift();
    if (!next) break;
    const directory = relative(root, next.path).split(sep).join("/") || ".";
    const exceeded =
      directories >= maxDirectories ||
      entries >= maxEntries ||
      performance.now() - started >= maxMilliseconds;
    if (exceeded) {
      incomplete(directory, "PWA discovery limit reached");
      break;
    }
    directories++;
    scan(next, directory);
  }
  result.entries.sort((left, right) => left.directory.localeCompare(right.directory));
  return result;
}
