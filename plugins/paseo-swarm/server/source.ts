import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { getConfigPath } from "./state";
import { listPwaRoles, readPwa } from "./pwa";

const configSchema = z
  .object({
    pwaRoot: z.string().min(1).optional(),
    projectSources: z.record(z.string(), z.string().min(1)).optional(),
  })
  .passthrough();

function readConfig(): z.infer<typeof configSchema> {
  let source: string;
  try {
    source = readFileSync(getConfigPath(), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
  return configSchema.parse(JSON.parse(source));
}

export function readPwaSource(projectId?: string): string | null {
  const config = readConfig();
  const projectSource = projectId ? config.projectSources?.[projectId] : undefined;
  const source = projectSource ?? config.pwaRoot ?? process.env.PASEO_SWARM_PWA_ROOT;
  return source ? resolve(source) : null;
}

export function requirePwaSource(projectId?: string): string {
  const source = readPwaSource(projectId);
  if (!source)
    throw new Error("No PWA directory configured. Choose one in Project Settings → Swarm.");
  return source;
}

interface SourceInput {
  path: string;
  projectId?: string;
  projectRoot?: string;
}

export function writePwaSource({ path, projectId, projectRoot }: SourceInput): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Enter a PWA directory.");
  if (projectId && !projectRoot) throw new Error(`Missing project root: ${projectId}`);
  const directory = resolve(projectRoot ?? process.cwd(), trimmed);
  const roles = listPwaRoles(directory);
  if (!roles.some((role) => role.roleClass === "planner")) {
    throw new Error("The PWA directory must contain a planner role.");
  }
  for (const role of roles) readPwa(directory, role.role);

  const config = readConfig();
  if (projectId) config.projectSources = { ...config.projectSources, [projectId]: directory };
  else config.pwaRoot = directory;
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(temporary, configPath);
  return directory;
}
