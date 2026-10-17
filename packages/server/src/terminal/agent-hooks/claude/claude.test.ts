import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isPlatform } from "../../../test-utils/platform.js";
import {
  buildTerminalEnvironment,
  resolvePaseoCliExecutablePath,
  resolveWorkspaceCliBin,
  resolvePaseoCliShim,
} from "../../terminal.js";
import { buildAgentHookShellCommand } from "../agent-hook-installer.js";
import {
  AGENT_HOOK_PROVIDERS,
  installRegisteredAgentHooks,
  registeredAgentHooksAreInstalled,
  uninstallRegisteredAgentHooks,
} from "../provider-registry.js";

const temporaryDirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  while (temporaryDirs.length > 0) {
    const dir = temporaryDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

function createFakeCliBinDir(): string {
  const dir = createTempDir("paseo-cli-bin-");
  writeFileSync(join(dir, "paseo"), "");
  return dir;
}

interface TestClaudeSettings {
  hooks?: Record<string, unknown>;
  theme?: string;
}

function readSettings(configDir: string): TestClaudeSettings {
  return JSON.parse(readFileSync(join(configDir, "settings.json"), "utf8")) as {
    hooks?: Record<string, unknown>;
    theme?: string;
  };
}

function hookCommands(settings: { hooks?: Record<string, unknown> }, event: string): string[] {
  const entries = settings.hooks?.[event];
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.flatMap((entry) => {
    if (!isRecord(entry) || !Array.isArray(entry.hooks)) {
      return [];
    }
    return entry.hooks
      .map((hook) => (isRecord(hook) ? hook.command : undefined))
      .filter((command): command is string => typeof command === "string");
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("CLI resolution", () => {
  it("uses the workspace CLI rather than an inherited upstream hook path", () => {
    vi.stubEnv("PASEO_CLI", "");
    vi.stubEnv("PASEO_HOOK_CLI", "/foreign/paseo");
    expect(realpathSync(resolvePaseoCliExecutablePath()!)).toBe(
      realpathSync(fileURLToPath(new URL("../../../../../cli/bin/paseo", import.meta.url))),
    );
  });
  it("resolves both source and compiled workspace layouts", () => {
    const expected = fileURLToPath(new URL("../../../../../cli/bin/paseo", import.meta.url));
    expect(resolveWorkspaceCliBin(import.meta.url)).toBe(expected);
    expect(
      resolveWorkspaceCliBin(
        new URL("../../../../dist/server/terminal/terminal.js", import.meta.url).href,
      ),
    ).toBe(expected);
  });
  it("accepts only Windows npm shims pointing at this CLI", () => {
    const binDir = createTempDir("swarm-cli-win-shim-");
    const cliEntry = join(binDir, "node_modules", "@paseo-swarm", "cli", "bin", "paseo");
    const shim = join(binDir, "paseo-swarm.cmd");
    writeFileSync(shim, '@echo off\r\nnode "%dp0%/node_modules/@getpaseo/cli/bin/paseo" %*');
    expect(resolvePaseoCliShim(binDir, cliEntry, "win32")).toBeNull();
    writeFileSync(shim, `@echo off\r\nnode "%dp0%/${relative(binDir, cliEntry)}" %*`);
    expect(resolvePaseoCliShim(binDir, cliEntry, "win32")).toBe(shim);
  });
  it("preserves an explicit CLI override", () => {
    const wrapper = join(createTempDir("swarm-cli-override-"), "cli-wrapper");
    vi.stubEnv("PASEO_CLI", wrapper);
    expect(resolvePaseoCliExecutablePath()).toBe(wrapper);
  });
});

describe("Claude terminal agent hooks", () => {
  it("installs registered provider hooks idempotently", () => {
    const configDir = createTempDir("paseo-claude-config-");
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const install = provider.install;

    installRegisteredAgentHooks({ configDir });
    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    for (const event of provider.events) {
      const paseoCommands = hookCommands(settings, event.event).filter((command) =>
        command.includes(install.hookMarker),
      );
      expect(paseoCommands).toHaveLength(1);
      expect(paseoCommands[0]).toBe(
        `if [ -n "$PASEO_TERMINAL_ID" ]; then "\${PASEO_HOOK_CLI:-paseo-swarm}" hooks ${provider.id} ${event.event}; fi`,
      );
    }
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(true);
  });

  it("preserves unrelated user hooks", () => {
    const configDir = createTempDir("paseo-claude-config-preserve-");
    writeFileSync(
      join(configDir, "settings.json"),
      `${JSON.stringify(
        {
          theme: "dark",
          hooks: {
            Stop: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "say done", timeout: 5 }],
              },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );

    installRegisteredAgentHooks({ configDir });

    const settings = readSettings(configDir);
    expect(settings.theme).toBe("dark");
    expect(hookCommands(settings, "Stop")).toContain("say done");
    expect(
      hookCommands(settings, "Stop").some((command) => command.includes("hooks claude Stop")),
    ).toBe(true);
  });

  it("uninstalls only marker-matched hooks", () => {
    const configDir = createTempDir("paseo-claude-config-uninstall-");
    installRegisteredAgentHooks({ configDir });
    const settings = readSettings(configDir);
    settings.hooks = {
      ...settings.hooks,
      Stop: [
        ...(Array.isArray(settings.hooks?.Stop) ? settings.hooks.Stop : []),
        {
          matcher: "",
          hooks: [{ type: "command", command: "say still-here", timeout: 5 }],
        },
      ],
    };
    writeFileSync(join(configDir, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);

    uninstallRegisteredAgentHooks({ configDir });

    const nextSettings = readSettings(configDir);
    expect(hookCommands(nextSettings, "Stop")).toEqual(["say still-here"]);
    expect(registeredAgentHooksAreInstalled({ configDir })).toBe(false);
  });

  it("builds a minimal gated hook command", () => {
    const provider = AGENT_HOOK_PROVIDERS.claude;
    const command = buildAgentHookShellCommand(provider, provider.events[0]);

    expect(command).toBe(
      'if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo-swarm}" hooks claude UserPromptSubmit; fi',
    );
  });

  it.skipIf(isPlatform("win32")).each(AGENT_HOOK_PROVIDERS.claude.events)(
    "$event hook command exits 0 when PASEO_TERMINAL_ID is unset",
    (event) => {
      const provider = AGENT_HOOK_PROVIDERS.claude;
      const command = buildAgentHookShellCommand(provider, event);

      const result = spawnSync("/bin/sh", ["-c", command], {
        env: { PATH: process.env.PATH ?? "", PASEO_HOOK_CLI: "paseo" },
        stdio: "ignore",
      });

      expect(result.status).toBe(0);
    },
  );

  it("keeps provider names out of the generic server bootstrap", () => {
    const source = readFileSync(
      new URL("../../../server/bootstrap.ts", import.meta.url),
      "utf8",
    ).toLowerCase();

    for (const providerId of Object.keys(AGENT_HOOK_PROVIDERS)) {
      expect(source).not.toContain(providerId);
    }
  });

  it("prepends the paseo CLI directory and injects the hook CLI path", () => {
    const cliBinDir = createFakeCliBinDir();
    const hookCliPath = join(cliBinDir, "paseo");

    const env = buildTerminalEnvironment({
      shell: "/bin/sh",
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      paseoCliBinDir: cliBinDir,
      paseoHookCliPath: hookCliPath,
    });

    expect(env.PATH?.split(delimiter)).toEqual([cliBinDir, "/usr/bin", "/bin"]);
    expect(env.PASEO_HOOK_CLI).toBe(hookCliPath);
  });

  it("leaves terminal PATH unchanged when the CLI directory cannot be resolved", () => {
    const env = buildTerminalEnvironment({
      shell: "/bin/sh",
      env: { PATH: ["/usr/bin", "/bin"].join(delimiter) },
      paseoCliBinDir: null,
    });

    expect(env.PATH?.split(delimiter)).toEqual(["/usr/bin", "/bin"]);
  });
});
