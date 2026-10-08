import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import * as daemonClient from "./utils/client.js";
import * as serverProcess from "@getpaseo/server/process";
import { runOpenCommand } from "./commands/agent/open.js";
import { openDesktopWithAgent } from "./commands/open.js";
import { resolveServerRunnerFromDir } from "./commands/daemon/local-daemon.js";
import { createCli } from "./cli";
import { createCliParseArgv, runCli } from "./run";

const runModuleUrl = new URL("./run.ts", import.meta.url).href;

// Runs the CLI in a child process whose stdout pipe has no reader, as when the
// program that launched it has already closed its end.
async function runCliWithClosedStdout(
  argv: string[],
): Promise<{ code: number | null; stderr: string }> {
  const script = `
    const { runCli } = await import(${JSON.stringify(runModuleUrl)});
    process.exitCode = await runCli(${JSON.stringify(argv)});
    await new Promise((resolve) => setTimeout(resolve, 100));
    process.stderr.write("still running\\n");
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: path.dirname(fileURLToPath(import.meta.url)),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.destroy();
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return { code, stderr };
}

describe("runCli", () => {
  it("retains empty-argument onboard under the fork display name", () => {
    expect(createCliParseArgv({ argv: [], cwd: process.cwd() })).toEqual([
      "paseo-swarm",
      "paseo-swarm",
      "onboard",
    ]);
  });

  it.each(["@getpaseo/server", "@paseo-swarm/server", "@other-owner/server"])(
    "checks the exact server identity and runner path: %s",
    (name) => {
      const root = mkdtempSync(path.join(tmpdir(), "paseo-runner-identity-"));
      try {
        writeFileSync(path.join(root, "package.json"), JSON.stringify({ name, version: "1.2.3" }));
        expect(resolveServerRunnerFromDir(root)).toBeNull();
        const scripts = path.join(root, "dist", "scripts");
        mkdirSync(scripts, { recursive: true });
        const runner = path.join(scripts, "supervisor-entrypoint.js");
        writeFileSync(runner, "// fixture; never executed\n");
        expect(resolveServerRunnerFromDir(root)).toBe(
          name === "@other-owner/server" ? null : runner,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("rejects a directory shortcut without spawning Desktop", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-desktop-disabled-"));
    const spawnSpy = vi.spyOn(serverProcess, "spawnProcess").mockImplementation(() => {
      throw new Error("Unexpected Desktop spawn");
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      expect(await runCli(["."], { cwd: root })).toBe(1);
      expect(stderr).toHaveBeenCalledWith(
        "paseo-swarm does not launch Desktop. Connect using the Web UI.\n",
      );
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally {
      process.exitCode = previousExitCode;
      stderr.mockRestore();
      spawnSpy.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([undefined, "explicit-server"])(
    "rejects agent open before connecting or spawning (server=%s)",
    async (server) => {
      const connect = vi
        .spyOn(daemonClient, "connectToDaemon")
        .mockRejectedValue(new Error("Unexpected daemon connection"));
      const spawnSpy = vi.spyOn(serverProcess, "spawnProcess").mockImplementation(() => {
        throw new Error("Unexpected Desktop spawn");
      });
      try {
        await expect(
          runOpenCommand(
            "agent-1",
            { daemonTarget: { kind: "endpoint", host: "localhost:1" }, server },
            new Command(),
          ),
        ).rejects.toMatchObject({ code: "DESKTOP_UNSUPPORTED" });
        await expect(
          openDesktopWithAgent({ serverId: "explicit-server", agentId: "agent-1" }),
        ).rejects.toMatchObject({ code: "DESKTOP_UNSUPPORTED" });
        expect(connect).not.toHaveBeenCalled();
        expect(spawnSpy).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
        spawnSpy.mockRestore();
      }
    },
  );

  it("lets plugin update own --version while preserving global output options", async () => {
    const cli = createCli()
      .exitOverride()
      .configureOutput({ writeOut: () => {} });
    const update = cli.commands
      .find((command) => command.name() === "plugin")!
      .commands.find((command) => command.name() === "update")!;
    let received: Record<string, unknown> | undefined;
    update.action((_id, options) => {
      received = options;
    });
    await cli.parseAsync(
      ["plugin", "update", "example", "--version", "1.2.0", "--format", "json", "--no-color"],
      { from: "user" },
    );
    expect(received).toMatchObject({ version: "1.2.0" });
    expect(update.optsWithGlobals()).toMatchObject({ format: "json", color: false });
  });

  it("defaults an empty CLI invocation to onboard", () => {
    expect(
      createCliParseArgv({
        argv: [],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard"]);
  });

  it("routes explicit root relay flags to onboard", () => {
    expect(
      createCliParseArgv({
        argv: ["--relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--relay"]);
    expect(
      createCliParseArgv({
        argv: ["--no-relay"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "onboard", "--no-relay"]);
  });

  it("preserves known CLI command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["daemon", "set-password"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "daemon", "set-password"]);
  });

  it("preserves the hooks command argv", () => {
    expect(
      createCliParseArgv({
        argv: ["hooks", "claude", "UserPromptSubmit"],
        cwd: process.cwd(),
        nodeArgv: ["node", "paseo"],
      }),
    ).toEqual(["node", "paseo", "hooks", "claude", "UserPromptSubmit"]);
  });

  it("finishes the command quietly when stdout is closed before it writes its output", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "paseo-cli-closed-stdout-"));

    try {
      const result = await runCliWithClosedStdout(["daemon", "status", "--json", "--home", home]);

      expect(result.stderr).toBe("still running\n");
      expect(result.code).toBe(0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);

  it("classifies existing unknown directories as open-project invocations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "paseo-cli-run-"));
    const project = path.join(root, "repository");
    mkdirSync(project);

    try {
      expect(
        createCliParseArgv({
          argv: ["repository"],
          cwd: root,
          nodeArgv: ["node", "paseo"],
        }),
      ).toEqual({
        kind: "open-project",
        resolvedPath: project,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
