import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml");
const { AppInfo } = require("app-builder-lib/out/appInfo");
const { LinuxTargetHelper } = require("app-builder-lib/out/targets/LinuxTargetHelper");
const AppImageTarget = require("app-builder-lib/out/targets/appimage/AppImageTarget").default;
const FpmTarget = require("app-builder-lib/out/targets/FpmTarget").default;
const { installLinuxLauncher } = require("../../scripts/linux-sandbox");

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function writeExecutable(filePath: string, contents: string): void {
  writeFileSync(filePath, contents, "utf8");
  chmodSync(filePath, 0o755);
}

function createFakeMacBundle(options: { includeHelper: boolean }): {
  root: string;
  shimPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "paseo-cli-shim-test-"));
  const appPath = join(root, "Paseo Swarm.app");
  const contentsPath = join(appPath, "Contents");
  const resourcesPath = join(contentsPath, "Resources");
  const shimPath = join(resourcesPath, "bin", "paseo");
  const mainPath = join(contentsPath, "MacOS", "Paseo Swarm");
  const helperPath = join(
    contentsPath,
    "Frameworks",
    "Paseo Swarm Helper.app",
    "Contents",
    "MacOS",
    "Paseo Swarm Helper",
  );

  mkdirSync(dirname(shimPath), { recursive: true });
  mkdirSync(dirname(mainPath), { recursive: true });
  copyFileSync(join(packageRoot, "bin", "paseo"), shimPath);
  chmodSync(shimPath, 0o755);

  writeExecutable(mainPath, "#!/bin/sh\necho main-executable\n");

  if (options.includeHelper) {
    mkdirSync(dirname(helperPath), { recursive: true });
    writeExecutable(
      helperPath,
      [
        "#!/bin/sh",
        'printf "helper env=%s/%s cli=%s\\n" "$ELECTRON_RUN_AS_NODE" "$PASEO_NODE_ENV" "$PASEO_CLI"',
        'printf "state=%s listen=%s\\n" "$PASEO_HOME" "$PASEO_LISTEN"',
        'printf "args=%s\\n" "$*"',
        "",
      ].join("\n"),
    );
  }

  return { root, shimPath };
}

describe("desktop packaging", () => {
  it.each(["deb", "rpm"])(
    "generates a valid %s package identifier for the Swarm product",
    async (target) => {
      const config = load(readFileSync(join(packageRoot, "electron-builder.yml"), "utf8"));
      const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      const appInfo = new AppInfo({ config, metadata }, undefined, config.linux);
      const metadataOptions = await FpmTarget.prototype.computeFpmMetaInfoOptions.call({
        options: { ...config.linux, ...config[target] },
        packager: { appInfo, info: { metadata } },
      });
      expect(metadataOptions.name).toMatch(/^[a-z0-9][a-z0-9+.-]+$/);
      expect(metadataOptions.name).toBe("paseo-swarm");
    },
  );

  it("generates Linux desktop entries matching the Swarm executable and dock identity", async () => {
    const config = load(readFileSync(join(packageRoot, "electron-builder.yml"), "utf8"));
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const appInfo = new AppInfo({ config, metadata }, undefined, config.linux);
    const packager = {
      config,
      appInfo,
      platformSpecificBuildOptions: config.linux,
      executableName: config.linux.executableName,
      fileAssociations: [],
    };
    const helper = new LinuxTargetHelper(packager);
    const entry = await helper.computeDesktopEntry(config.linux);
    expect(metadata.desktopName).toBe(`${appInfo.productFilename}.desktop`);
    expect(entry).toContain(`Exec="/opt/${config.productName}/${packager.executableName}" %U`);
    expect(entry).toContain(`StartupWMClass=${config.productName}`);
    const appImage = new AppImageTarget("appImage", packager, helper, "unused");
    expect(await appImage.desktopEntry.value).toContain(
      `Exec=AppRun --class="${config.productName}" %U`,
    );
  });

  it("wraps the executable selected by the Linux builder configuration", () => {
    const config = load(readFileSync(join(packageRoot, "electron-builder.yml"), "utf8"));
    const executableName = config.linux.executableName ?? config.executableName;
    const root = mkdtempSync(join(tmpdir(), "paseo-linux-packaging-"));
    try {
      writeFileSync(join(root, executableName), "electron executable");
      installLinuxLauncher(root);
      expect(readFileSync(join(root, `${executableName}.bin`), "utf8")).toBe("electron executable");
      expect(readFileSync(join(root, executableName), "utf8")).toBe(
        readFileSync(join(packageRoot, "scripts", "linux-sandbox", "launcher.sh"), "utf8"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses an Electron runtime whose Squirrel handoff explicitly wakes ShipIt", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const electronVersion = pkg.devDependencies?.electron ?? "0.0.0";
    const electronMajor = Number(electronVersion.split(".")[0]);

    expect(electronMajor).toBeGreaterThanOrEqual(44);
  });

  it("requires macOS 13 or newer in the packaged application", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain('minimumSystemVersion: "13.0.0"');
  });

  it("unpacks server zsh shell integration files for external shells", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain(
      "node_modules/@getpaseo/server/dist/server/terminal/shell-integration/**/*",
    );
    expect(config).not.toContain(
      "node_modules/@getpaseo/server/dist/src/terminal/shell-integration/**/*",
    );
  });

  it("excludes package debug/source files from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!**/*.map");
    expect(config).toContain("!node_modules/@getpaseo/*/src/**");
    expect(config).toContain("!node_modules/@getpaseo/**/*.test.*");
    expect(config).toContain("!node_modules/@getpaseo/**/*.spec.*");
  });

  it("excludes the bundled daemon web UI from the packaged app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("!node_modules/@getpaseo/server/dist/server/web-ui/**");
  });

  it("uses the server skill catalog without a duplicate desktop resource", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
    const serverPackage = readFileSync(join(packageRoot, "..", "server", "package.json"), "utf8");
    const runtimeTrace = readFileSync(
      join(packageRoot, "..", "..", "scripts", "trace-daemon.mjs"),
      "utf8",
    );

    expect(config).not.toContain("from: ../../skills");
    expect(serverPackage).toContain("fs.rmSync('dist/server/skills',{recursive:true,force:true})");
    expect(serverPackage).toContain("fs.cpSync('../../skills','dist/server/skills'");
    expect(runtimeTrace).toContain('"packages/server/dist/server/skills/**"');
  });

  it("leaves official Paseo agent links with the official app", () => {
    const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");

    expect(config).toContain("protocols: []");
    expect(config).not.toContain("- paseo");
  });

  // electron-builder packs production dependencies declared in package.json into
  // app.asar. Runtime code in runtime-paths.ts and bin/paseo dynamically resolves
  // these workspace packages by string, so static analysis (TypeScript, Knip) cannot
  // see the link. If a runtime-required workspace dep is dropped from
  // dependencies, the build still succeeds but ships a broken bundle. This
  // assertion is the safety net.
  it("declares all workspace packages required at runtime", () => {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    const deps = pkg.dependencies ?? {};

    for (const required of ["@getpaseo/cli", "@getpaseo/server"]) {
      expect(deps[required], `${required} must be declared in dependencies`).toBe("*");
    }
  });

  it("launches the packaged macOS CLI through Helper instead of the main app executable", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`helper env=1/production cli=${bundle.shimPath}`);
      expect(result.stdout).toContain("node-entrypoint-runner.js");
      expect(result.stdout).toContain("node-script");
      expect(result.stdout).toContain("@getpaseo/cli/dist/index.js");
      expect(result.stdout).toContain("--version");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("keeps the public paseo-swarm link on the bundled shim and isolated daemon", () => {
    if (process.platform === "win32") return;
    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const command = join(bundle.root, "paseo-swarm");
      symlinkSync(bundle.shimPath, command);
      const state = join(bundle.root, "swarm-state");
      const result = spawnSync(command, ["--version"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PASEO_HOME: state,
          PASEO_LISTEN: "127.0.0.1:16769",
        },
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`cli=${bundle.shimPath}`);
      expect(result.stdout).toContain(`state=${state} listen=127.0.0.1:16769`);
      expect(result.stdout).toContain("@getpaseo/cli/dist/index.js");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it.each(["paseo-swarm", "paseo-swarm.bin"])(
    "runs the Linux CLI shim through %s",
    (executable) => {
      if (process.platform === "win32") return;
      const root = mkdtempSync(join(tmpdir(), "swarm-linux-cli-"));
      try {
        const bin = join(root, "resources", "bin");
        mkdirSync(bin, { recursive: true });
        const shim = join(bin, "paseo");
        copyFileSync(join(packageRoot, "bin", "paseo"), shim);
        chmodSync(shim, 0o755);
        writeExecutable(
          join(root, executable),
          '#!/bin/sh\nprintf "state=%s listen=%s" "$PASEO_HOME" "$PASEO_LISTEN"\n',
        );
        const result = spawnSync(shim, ["--version"], {
          encoding: "utf8",
          env: { ...process.env, PASEO_HOME: root, PASEO_LISTEN: "127.0.0.1:16769" },
        });
        expect(result.status).toBe(0);
        expect(result.stdout).toBe(`state=${root} listen=127.0.0.1:16769`);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("uses Swarm CLI defaults when the existing env variables are unset", () => {
    if (process.platform === "win32") return;
    const bundle = createFakeMacBundle({ includeHelper: true });
    try {
      const env = { ...process.env, HOME: bundle.root };
      delete env.PASEO_HOME;
      delete env.PASEO_LISTEN;
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8", env });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        `state=${join(bundle.root, ".paseo-swarm")} listen=127.0.0.1:6769`,
      );
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });

  it("uses the builder executable name in the Windows CLI shim", () => {
    const config = load(readFileSync(join(packageRoot, "electron-builder.yml"), "utf8"));
    const executableName = config.win.executableName ?? config.executableName;
    const shim = readFileSync(join(packageRoot, "bin", "paseo.cmd"), "utf8");
    expect(shim).toContain(`\\..\\${executableName}.exe`);
  });

  it("fails packaged macOS CLI startup when Helper is missing", () => {
    if (process.platform === "win32") return;

    const bundle = createFakeMacBundle({ includeHelper: false });
    try {
      const result = spawnSync(bundle.shimPath, ["--version"], { encoding: "utf8" });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Bundled Paseo Helper executable not found");
      expect(result.stdout).not.toContain("main-executable");
    } finally {
      rmSync(bundle.root, { recursive: true, force: true });
    }
  });
});

it("installs the Linux helper as root-owned 4755 regardless of root's namespace access", () => {
  const config = readFileSync(join(packageRoot, "electron-builder.yml"), "utf8");
  expect(config).toContain("afterInstall: scripts/linux-sandbox/after-install.tpl");
  const installer = readFileSync(
    join(packageRoot, "scripts/linux-sandbox/after-install.tpl"),
    "utf8",
  );
  expect(installer).not.toContain("unshare");
  expect(installer).toContain("chown root:root '/opt/${sanitizedProductName}/chrome-sandbox'");
  expect(installer).toContain("chmod 4755 '/opt/${sanitizedProductName}/chrome-sandbox'");
  expect(installer).not.toContain("chmod 0755");
});
