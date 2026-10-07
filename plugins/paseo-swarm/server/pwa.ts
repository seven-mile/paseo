import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
  return value as Record<string, unknown>;
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

export function readPwa(directory: string, role: string): Pwa {
  validateRole(role);

  const pwaPath = join(directory, "PWA.md");
  const rolePath = join(directory, "roles", `${role}.md`);
  let pwaSource: string;
  let roleSource: string;
  try {
    pwaSource = readFileSync(pwaPath, "utf8");
  } catch (error) {
    throw new Error(
      `Missing PWA.md in ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  try {
    roleSource = readFileSync(rolePath, "utf8");
  } catch (error) {
    throw new Error(
      `Missing role: ${role}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }

  const pwaDocument = document(pwaSource, "PWA.md");
  const pwa = record(pwaDocument.data, "PWA.md");
  const roleDocument = document(roleSource, `roles/${role}.md`);
  const roleData = record(roleDocument.data, `roles/${role}.md`);

  if (pwa.version !== 1) throw new Error("PWA.md frontmatter version must be 1");
  if (roleData.version !== 1) {
    throw new Error(`roles/${role}.md frontmatter version must be 1`);
  }

  const project = requiredString(pwa.project, "project", "PWA.md");
  const roleClass = roleData.roleClass;
  if (roleClass !== "planner" && roleClass !== "supervisor" && roleClass !== "worker") {
    throw new Error(`roles/${role}.md frontmatter roleClass is invalid`);
  }
  if (roleData.title !== undefined && typeof roleData.title !== "string") {
    throw new Error(`roles/${role}.md frontmatter field title must be a string`);
  }

  const statuses = pwa.statuses === undefined ? [] : pwa.statuses;
  if (!Array.isArray(statuses) || statuses.some((status) => typeof status !== "string")) {
    throw new Error("PWA.md frontmatter field statuses must be an array of strings");
  }

  const revision = createHash("sha256")
    .update(pwaSource)
    .update("\0")
    .update(roleSource)
    .digest("hex");

  return {
    project,
    role,
    roleClass,
    projectBody: pwaDocument.body,
    roleBody: roleDocument.body,
    statuses: [...statuses],
    revision,
  };
}

export function listPwaRoles(directory: string): PwaRole[] {
  const rolesDirectory = join(directory, "roles");
  return readdirSync(rolesDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const role = entry.name.slice(0, -3);
      validateRole(role);
      const roleDocument = document(
        readFileSync(join(rolesDirectory, entry.name), "utf8"),
        `roles/${entry.name}`,
      );
      const roleData = record(roleDocument.data, `roles/${entry.name}`);
      if (roleData.version !== 1)
        throw new Error(`roles/${entry.name} frontmatter version must be 1`);
      const roleClassValue = roleData.roleClass;
      if (
        roleClassValue !== "planner" &&
        roleClassValue !== "supervisor" &&
        roleClassValue !== "worker"
      ) {
        throw new Error(`roles/${entry.name} frontmatter roleClass is invalid`);
      }
      const roleClass: RoleClass = roleClassValue;
      const title =
        roleData.title === undefined
          ? role
          : requiredString(roleData.title, "title", `roles/${entry.name}`);
      return { role, roleClass, title, description: roleDocument.body };
    })
    .sort((left, right) => left.role.localeCompare(right.role));
}
