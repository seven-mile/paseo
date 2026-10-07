import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(serverRoot, "../../plugins/paseo-swarm/index.server.ts");
// Packaged built-ins live outside app.asar. Inline Swarm's YAML dependency while
// keeping the existing plugin host modules external for the normal compiler.
const result = await build({
  entryPoints: [source],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: ["@getpaseo/plugin", "@getpaseo/plugin/*", "zod"],
  write: false,
  metafile: true,
});
if (
  Object.values(result.metafile.outputs).some((output) =>
    output.imports.some((item) => item.external && item.path === "yaml"),
  )
) {
  throw new Error("Swarm packaged entry must inline YAML");
}
await writeFile(
  path.join(serverRoot, "dist/server/builtin-plugins/paseo-swarm/index.server.ts"),
  result.outputFiles[0].text,
);
