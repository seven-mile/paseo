import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

interface ResolvePackageVersionParams {
  moduleUrl?: string;
  packageName: string | readonly string[];
}

export const packageJsonSchema = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
});

export type PackageJson = z.infer<typeof packageJsonSchema>;

function parsePackageJson(raw: unknown): PackageJson | null {
  const result = packageJsonSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export class PackageVersionResolutionError extends Error {
  constructor(params: { moduleUrl: string; packageName: string }) {
    super(`Unable to resolve ${params.packageName} version from module URL ${params.moduleUrl}.`);
    this.name = "PackageVersionResolutionError";
  }
}

function readMatchingPackageVersion(
  packageJsonPath: string,
  packageNames: readonly string[],
  moduleUrl: string,
): string | null {
  let packageJson: PackageJson;
  try {
    const parsed = parsePackageJson(JSON.parse(readFileSync(packageJsonPath, "utf8")));
    if (!parsed) return null;
    packageJson = parsed;
  } catch {
    return null;
  }
  if (!packageNames.includes(packageJson.name ?? "")) {
    return null;
  }
  if (typeof packageJson.version === "string" && packageJson.version.trim().length > 0) {
    return packageJson.version.trim();
  }
  throw new PackageVersionResolutionError({ moduleUrl, packageName: packageNames.join(" or ") });
}

export function resolvePackageVersion(params: ResolvePackageVersionParams): string {
  const moduleUrl = params.moduleUrl ?? import.meta.url;
  const packageNames =
    typeof params.packageName === "string" ? [params.packageName] : params.packageName;
  let currentDir = path.dirname(fileURLToPath(moduleUrl));

  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    if (existsSync(packageJsonPath)) {
      const version = readMatchingPackageVersion(packageJsonPath, packageNames, moduleUrl);
      if (version !== null) {
        return version;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  throw new PackageVersionResolutionError({
    moduleUrl,
    packageName: packageNames.join(" or "),
  });
}
