import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createCli } from "./cli.js";

describe("canonical CLI surface", () => {
  it("shows the fork command and defaults while retaining onboard", () => {
    const cli = createCli();
    expect(cli.name()).toBe("paseo-swarm");
    expect(cli.helpInformation()).toContain("~/.paseo-swarm");
    const onboard = cli.commands.find((command) => command.name() === "onboard");
    expect(onboard?.helpInformation()).toContain("default: 6769");
  });
  it("derives every registered command usage from the root command name", () => {
    const visit = (command: ReturnType<typeof createCli>) => {
      expect(command.helpInformation().split("\n")[0]).toMatch(/^Usage: paseo-swarm(?: |$)/u);
      for (const child of command.commands) visit(child);
    };
    visit(createCli());
  });
  it("flags hardcoded upstream command hints in CLI source", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const findings: string[] = [];
    for (const file of readdirSync(root, { recursive: true })) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const lines = readFileSync(path.join(root, file), "utf8").split("\n");
      lines.forEach((line, index) => {
        // This is a spelling tripwire, not a parser: comments and @paseo Hub mentions are excluded.
        if (/^\s*(?:\/\/|\*)/u.test(line)) return;
        if (/(?<![\w@./-])paseo\s+(?:[a-z][\w-]*|--[\w-]+)/u.test(line)) {
          findings.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(
      findings,
      "Review new upstream command hints; use paseo-swarm for executable examples",
    ).toEqual([]);
  });
  it("offers daemon host selection as a global option", () => {
    expect(createCli().helpInformation()).toContain("--host <host>");
  });

  it("shows project, workspace, and heartbeat commands while hiding worktree compatibility", () => {
    const cli = createCli();
    const help = cli.helpInformation();
    expect(help).toContain("project");
    expect(help).toContain("workspace");
    expect(help).toContain("heartbeat");
    expect(help).not.toContain("worktree");
  });

  it("offers identical top-level and daemon config reload commands", () => {
    const cli = createCli();
    const reload = cli.commands.find((command) => command.name() === "reload");
    const daemon = cli.commands.find((command) => command.name() === "daemon");
    const nestedReload = daemon?.commands.find((command) => command.name() === "reload");

    expect(reload?.helpInformation()).toContain("--host <host>");
    expect(reload?.helpInformation()).toContain("--json");
    expect(nestedReload?.helpInformation()).toContain("--host <host>");
    expect(nestedReload?.helpInformation()).toContain("--json");
  });

  it("names explicit workspace creation without exposing older syntax", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--new-workspace <local|worktree>");
    expect(help).not.toContain("--isolation");
    expect(help).not.toContain("--worktree <name>");
  });

  it("offers the worktree creation options on run", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    const help = run?.helpInformation();
    expect(help).toContain("--worktree-mode <mode>");
    expect(help).toContain("--worktree-slug <slug>");
    expect(help).toContain("--new-branch <name>");
    expect(help).toContain("--branch <name>");
    expect(help).toContain("--pr-number <n>");
    expect(help).toContain("--forge <forge>");
  });

  it("uses background for execution and reserves detach for ownership", () => {
    const run = createCli().commands.find((command) => command.name() === "run");
    expect(run?.helpInformation()).toContain("--background");
    expect(run?.helpInformation()).not.toContain("--detach");
  });

  it("offers thinking configuration when running, updating, and scheduling agents", () => {
    const cli = createCli();
    const run = cli.commands.find((command) => command.name() === "run");
    const agent = cli.commands.find((command) => command.name() === "agent");
    const update = agent?.commands.find((command) => command.name() === "update");
    const schedule = cli.commands.find((command) => command.name() === "schedule");
    const scheduleCreate = schedule?.commands.find((command) => command.name() === "create");

    expect(run?.helpInformation()).toContain("--thinking <id>");
    expect(update?.helpInformation()).toContain("--thinking <id>");
    expect(scheduleCreate?.helpInformation()).toContain("--thinking <id>");
  });

  it("keeps agent open discoverable with an unsupported Desktop description", () => {
    const agent = createCli().commands.find((command) => command.name() === "agent");
    const open = agent?.commands.find((command) => command.name() === "open");

    expect(open?.helpInformation()).toContain("<agent-id>");
    expect(open?.helpInformation()).toContain("--server <server-id>");
    expect(open?.helpInformation()).toContain("Desktop launch is unsupported");
  });

  it("offers the complete local plugin lifecycle", () => {
    const plugin = createCli().commands.find((command) => command.name() === "plugin");

    expect(plugin?.commands.map((command) => command.name())).toEqual([
      "init",
      "ls",
      "status",
      "logs",
      "install",
      "update",
      "reload",
      "enable",
      "disable",
      "remove",
    ]);
    expect(
      plugin?.commands.find((command) => command.name() === "init")?.helpInformation(),
    ).toContain("--id <id>");
    expect(
      plugin?.commands.find((command) => command.name() === "install")?.helpInformation(),
    ).toContain("--id <id>");
  });
});
