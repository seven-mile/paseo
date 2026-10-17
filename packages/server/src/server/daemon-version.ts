import { PackageVersionResolutionError, resolvePackageVersion } from "./package-version.js";

const SERVER_PACKAGE_NAMES = ["@getpaseo/server", "@paseo-swarm/server"] as const;

export class DaemonVersionResolutionError extends PackageVersionResolutionError {}

export function resolveDaemonVersion(moduleUrl: string = import.meta.url): string {
  try {
    return resolvePackageVersion({ moduleUrl, packageName: SERVER_PACKAGE_NAMES });
  } catch (error) {
    if (error instanceof PackageVersionResolutionError) {
      throw new DaemonVersionResolutionError({
        moduleUrl,
        packageName: SERVER_PACKAGE_NAMES.join(" or "),
      });
    }
    throw error;
  }
}
