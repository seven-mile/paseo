import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { PwaBinding } from "../shared/models";
import { getConfigPath } from "./state";
import { listPwaRoles, resolvePwaDirectory } from "./pwa";

const configSchema = z
  .object({
    pwaRoot: z.string().min(1).optional(),
    projectSources: z.record(z.string(), z.string().min(1)).optional(),
    defaultPwa: z.string().nullable().optional(),
    projectDefaults: z.record(z.string(), z.string().nullable()).optional(),
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
  const path = source ? resolve(projectRoot ?? process.cwd(), source) : null;
  const defaultPwa =
    projectSource && projectId ? config.projectDefaults?.[projectId] : config.defaultPwa;
  return { path, defaultPwa: defaultPwa ?? null };
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
  defaultPwa?: string | null;
}

export function writePwaSource({ path, projectId, projectRoot, defaultPwa }: SourceInput): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("Enter a PWA directory.");
  if (projectId && !projectRoot) throw new Error(`Missing project root: ${projectId}`);
  const directory = realpathSync(resolve(projectRoot ?? process.cwd(), trimmed));
  if (!statSync(directory).isDirectory())
    throw new Error(`Not a PWA content directory: ${directory}`);
  let selectedDefault = defaultPwa;
  if (defaultPwa !== undefined && defaultPwa !== null) {
    if (!defaultPwa.trim() || isAbsolute(defaultPwa))
      throw new Error("Default PWA must be a relative directory.");
    const selected = resolvePwaBinding({ directory: defaultPwa, contentRoot: directory });
    selectedDefault = relative(directory, selected.directory).split(sep).join("/") || ".";
  }
  const config = readConfig();
  if (projectId) {
    config.projectSources = { ...config.projectSources, [projectId]: directory };
    if (defaultPwa !== undefined)
      config.projectDefaults = { ...config.projectDefaults, [projectId]: selectedDefault ?? null };
  } else {
    config.pwaRoot = directory;
    if (defaultPwa !== undefined) config.defaultPwa = selectedDefault;
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

export function validatePwaBinding(binding: PwaBinding): PwaBinding {
  const contentRoot = realpathSync(binding.contentRoot);
  const directory = resolvePwaDirectory(binding.directory, contentRoot);
  if (contentRoot !== binding.contentRoot || directory !== binding.directory) {
    throw new Error("The bound PWA path has changed. Confirm its source explicitly.");
  }
  const entry = realpathSync(resolve(directory, "PWA.md"));
  if (resolvePwaDirectory(dirname(entry), contentRoot) !== dirname(entry)) {
    throw new Error("The bound PWA entry is outside its content root.");
  }
  readFileSync(entry, "utf8");
  return binding;
}
