import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { getConfigPath } from "./state";

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

// The PWA directory chosen for a project, or for every project, before swarms. A swarm is
// instantiated from it on first use; after that the swarm's own directory is what counts.
export function readPwaSource(projectId?: string): string | null {
  const config = readConfig();
  const projectSource = projectId ? config.projectSources?.[projectId] : undefined;
  const source = projectSource ?? config.pwaRoot ?? process.env.PASEO_SWARM_PWA_ROOT;
  return source ? resolve(source) : null;
}
