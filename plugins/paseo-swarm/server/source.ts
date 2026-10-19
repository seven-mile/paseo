import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { PwaBinding } from "../shared/models";
import { getConfigPath } from "./state";
import { listPwaRoles, resolvePwaDirectory } from "./pwa";

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

export function readPwaSourceConfig(projectId?: string, projectRoot?: string) {
  const config = readConfig();
  const projectSource = projectId ? config.projectSources?.[projectId] : undefined;
  const source = projectSource ?? config.pwaRoot ?? process.env.PASEO_SWARM_PWA_ROOT;
  if (projectSource && !isAbsolute(projectSource) && !projectRoot) {
    throw new Error(`Missing project root: ${projectId}`);
  }
  const base = projectSource && projectRoot ? projectRoot : process.cwd();
  const path = source ? resolve(base, source) : null;
  return { path };
}

export function readPwaSource(projectId?: string, projectRoot?: string): string | null {
  return readPwaSourceConfig(projectId, projectRoot).path;
}

export function requirePwaSource(projectId?: string, projectRoot?: string): string {
  const source = readPwaSource(projectId, projectRoot);
  if (!source)
    throw new Error("No PWA content directory configured. Choose one in Project Settings → Swarm.");
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
  const directory = realpathSync(resolve(projectRoot ?? process.cwd(), trimmed));
  if (!statSync(directory).isDirectory())
    throw new Error(`Not a PWA content directory: ${directory}`);
  const config = readConfig();
  if (projectId) {
    config.projectSources = { ...config.projectSources, [projectId]: directory };
  } else {
    config.pwaRoot = directory;
  }
  const configPath = getConfigPath();
  mkdirSync(dirname(configPath), { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(temporary, configPath);
  return directory;
}

interface BindingInput {
  projectId?: string;
  directory: string;
  contentRoot?: string;
  projectRoot?: string;
}

export function resolvePwaBinding({
  projectId,
  directory,
  contentRoot,
  projectRoot,
}: BindingInput): PwaBinding {
  if (!directory.trim()) throw new Error("Choose a PWA directory explicitly.");
  const root = realpathSync(contentRoot ?? requirePwaSource(projectId, projectRoot));
  const path = resolvePwaDirectory(directory, root);
  const roles = listPwaRoles(path, root);
  if (!roles.some((role) => role.roleClass === "planner")) {
    throw new Error(`PWA must declare a planner role: ${path}`);
  }
  return { ...(projectId ? { projectId } : {}), contentRoot: root, directory: path };
}

// Schema v1 supports a configured root that is itself a PWA.
// Discovered descendants never choose a legacy team's workflow.
export function resolveLegacyPwaBinding(projectId?: string, projectRoot?: string): PwaBinding {
  const contentRoot = realpathSync(requirePwaSource(projectId, projectRoot));
  return validatePwaBinding({
    ...(projectId ? { projectId } : {}),
    contentRoot,
    directory: contentRoot,
  });
}

export function validatePwaBinding(binding: PwaBinding): PwaBinding {
  const contentRoot = realpathSync(binding.contentRoot);
  const directory = resolvePwaDirectory(binding.directory, contentRoot);
  if (contentRoot !== binding.contentRoot || directory !== binding.directory) {
    throw new Error(
      "The bound PWA path has changed. Restore its original path or create a new team with the intended PWA.",
    );
  }
  const entry = realpathSync(resolve(directory, "PWA.md"));
  if (resolvePwaDirectory(dirname(entry), contentRoot) !== dirname(entry)) {
    throw new Error("The bound PWA entry is outside its content root.");
  }
  readFileSync(entry, "utf8");
  return binding;
}
