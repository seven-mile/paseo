import type { ChildProcess } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { execCommand, terminateProcess } from "@getpaseo/plugin/server";

import { runGitCommand } from "./run-git-command.js";
import * as gitSpawn from "./spawn.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-shell-"));
  tempDirs.push(repo);
  return repo;
}

function releaseWindowsFixtureCwd(repo: string): boolean {
  rmSync(repo, { recursive: true, force: true });
  const released = !existsSync(repo);
  if (!released) throw new Error("Owned Windows fixture cwd remains");
  return released;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

function recordOwnership(event: string, startedAt: number, details: Record<string, unknown>): void {
  const destination = process.env.PASEO_GIT_OWNERSHIP_LOG;
  if (destination)
    appendFileSync(
      destination,
      JSON.stringify({ event, elapsedMs: performance.now() - startedAt, ...details }) + "\n",
    );
}

interface WindowsOwner {
  pid: number;
  parent: number;
  created: string;
}

// Actual Windows metadata only. Do not collect command lines, paths or environment.
async function readWindowsOwners(
  pids: number[],
  descendants: boolean,
  timeout: number,
): Promise<WindowsOwner[]> {
  if (!pids.every((pid) => Number.isInteger(pid) && pid > 0))
    throw new Error("Invalid synthetic Windows owner PID");
  if (!descendants && pids.length !== 1) throw new Error("Identity query must name one owned PID");
  const script = `
    $ErrorActionPreference = 'Stop'
    $rows = @(Get-CimInstance Win32_Process ${descendants ? "" : `-Filter 'ProcessId=${pids[0]}'`})
    $ids = @(${pids.join(",")})
    ${
      descendants
        ? `do {
      $next = @($rows | Where-Object { $ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId })
      $ids += @($next | ForEach-Object { [int]$_.ProcessId })
      if ($ids.Count -gt 16) { throw 'Synthetic Windows owner tree exceeds bound' }
    } while ($next.Count -gt 0)`
        : ""
    }
    $selected = @($rows | Where-Object { $ids -contains [int]$_.ProcessId } | ForEach-Object {
      @{ pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o') }
    })
    ConvertTo-Json -InputObject $selected -Compress
  `;
  const result = await execCommand(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    {
      shell: false,
      timeout,
      maxBuffer: 64 * 1024,
    },
  );
  const rows = JSON.parse(result.stdout) as WindowsOwner[];
  if (
    !Array.isArray(rows) ||
    rows.length > 16 ||
    !rows.every(
      (row) =>
        Number.isInteger(row.pid) &&
        row.pid > 0 &&
        Number.isInteger(row.parent) &&
        row.parent >= 0 &&
        typeof row.created === "string" &&
        row.created.length > 0 &&
        row.created.length <= 128,
    ) ||
    new Set(rows.map((row) => row.pid)).size !== rows.length
  )
    throw new Error("Invalid synthetic Windows owner identities");
  return rows;
}

async function stopWindowsOwner(pid: number, captured: WindowsOwner[]): Promise<void> {
  if (!isProcessRunning(pid)) return;
  const before = captured.find((row) => row.pid === pid);
  const deadline = performance.now() + 5000;
  const current = await readWindowsOwners([pid], false, 5000);
  const now = current.find((row) => row.pid === pid);
  if (!now && !isProcessRunning(pid)) return;
  if (!before || !now || before.created !== now.created)
    throw new Error("Windows synthetic owner identity is unknown or changed");
  const remaining = Math.floor(deadline - performance.now());
  if (remaining <= 0) throw new Error("Windows owner identity exhausted cleanup budget");
  try {
    await execCommand("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      shell: false,
      timeout: remaining,
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === 128)) throw error;
  }
}

async function cleanupWindowsOwners(
  pidFile: string,
  pids: { owner: number; descendant: number } | undefined,
  gitChild: ChildProcess | undefined,
  captured: WindowsOwner[],
): Promise<{ owned: number[]; errors: unknown[] }> {
  const errors: unknown[] = [];
  if (!pids) {
    try {
      const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as {
        owner: number;
        descendant: number;
      };
      if ([parsed.owner, parsed.descendant].every((pid) => Number.isInteger(pid) && pid > 0))
        pids = parsed;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        errors.push(error);
    }
  }
  const owned = [
    ...new Set(
      [gitChild?.pid, pids?.owner, pids?.descendant, ...captured.map((row) => row.pid)].filter(
        (pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0,
      ),
    ),
  ];
  // Attempt the held real root through SDK, then every captured intermediate owner.
  // SDK failure is recorded as unknown; this does not claim a direct-kill fallback.
  try {
    if (gitChild?.pid && gitChild.exitCode === null && gitChild.signalCode === null)
      await terminateProcess(gitChild);
  } catch (error) {
    errors.push(error);
  }
  const stops = await Promise.allSettled(owned.map((pid) => stopWindowsOwner(pid, captured)));
  for (const stop of stops) if (stop.status === "rejected") errors.push(stop.reason);
  const drains = await Promise.allSettled(
    owned.map((pid) =>
      vi.waitFor(
        () => {
          expect(isProcessRunning(pid)).toBe(false);
        },
        { timeout: 5000, interval: 25 },
      ),
    ),
  );
  for (const drain of drains) if (drain.status === "rejected") errors.push(drain.reason);
  return { owned, errors };
}

describe("runGitCommand shell behavior", () => {
  it("passes git arguments directly instead of through the platform shell", async () => {
    const repo = makeTempRepo();
    const literalName = "%PASEO_GIT_SHELL_SENTINEL%";
    const expandedName = "expanded-by-cmd";

    await runGitCommand(["init"], { cwd: repo });
    writeFileSync(path.join(repo, literalName), "literal\n");
    writeFileSync(path.join(repo, expandedName), "expanded\n");
    await runGitCommand(["add", literalName, expandedName], { cwd: repo });

    const result = await runGitCommand(["ls-files", "--error-unmatch", literalName], {
      cwd: repo,
      envOverlay: {
        PASEO_GIT_SHELL_SENTINEL: expandedName,
      },
    });

    expect(result.stdout.trim()).toBe(literalName);
  });

  it.runIf(process.platform === "win32")(
    "stops Git-owned Windows helper descendants before timeout rejection",
    async () => {
      const startedAt = performance.now();
      const repo = makeTempRepo();
      recordOwnership("fixture", startedAt, { repoName: path.basename(repo) });
      await runGitCommand(["init"], { cwd: repo });
      const helper = path.join(repo, "owned-helper.cjs");
      const pidFile = path.join(repo, "owned-helper-pids.json");
      const descendant = `
      require("node:fs").writeFileSync(process.env.PASEO_GIT_HELPER_PIDS,
        JSON.stringify({ owner: process.ppid, descendant: process.pid }));
      setInterval(() => {}, 1000);
    `;
      writeFileSync(
        helper,
        `
      require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `,
      );
      let pids: { owner: number; descendant: number } | undefined;
      let gitChild: ChildProcess | undefined;
      let ownedTree: WindowsOwner[] = [];
      let gitCommandStartedAt = 0;
      const actualSpawn = gitSpawn.spawnProcess;
      const observation = vi.spyOn(gitSpawn, "spawnProcess").mockImplementation((...args) => {
        const commandStartedAt = performance.now();
        const child = actualSpawn(...args);
        if (args[0] === "git" && args[1].includes("paseo-timeout-owner")) {
          gitChild = child;
          gitCommandStartedAt = commandStartedAt;
          recordOwnership("git-start", startedAt, {
            gitPid: child.pid,
            commandStartedMs: gitCommandStartedAt - startedAt,
          });
        }
        return child;
      });
      // A real Git shell alias owns the real Node helper and grandchild. No spawn/kill mock.
      const timedOut = runGitCommand(
        [
          "-c",
          'alias.paseo-timeout-owner=!"$PASEO_GIT_HELPER_NODE" "$PASEO_GIT_HELPER_SCRIPT"',
          "paseo-timeout-owner",
        ],
        {
          cwd: repo,
          timeout: 10_000,
          envOverlay: {
            PASEO_GIT_HELPER_NODE: process.execPath.replaceAll("\\", "/"),
            PASEO_GIT_HELPER_SCRIPT: helper.replaceAll("\\", "/"),
            PASEO_GIT_HELPER_PIDS: pidFile,
          },
        },
      ).then(
        () => null,
        (error: unknown) => error,
      );
      let failure: unknown;
      let caseFailed = false;
      const cleanupErrors: unknown[] = [];
      try {
        await vi.waitFor(
          () => {
            const parsed = JSON.parse(readFileSync(pidFile, "utf8")) as {
              owner: number;
              descendant: number;
            };
            expect(Number.isInteger(parsed.owner) && parsed.owner > 0).toBe(true);
            expect(Number.isInteger(parsed.descendant) && parsed.descendant > 0).toBe(true);
            pids = parsed;
            expect(gitChild?.pid).toBeTypeOf("number");
            expect(isProcessRunning(gitChild!.pid!)).toBe(true);
            expect(isProcessRunning(parsed.owner)).toBe(true);
            expect(isProcessRunning(parsed.descendant)).toBe(true);
          },
          { timeout: 5000, interval: 25 },
        );
        const remaining = Math.floor(10_000 - (performance.now() - gitCommandStartedAt));
        expect(remaining).toBeGreaterThan(0);
        ownedTree = await readWindowsOwners([gitChild!.pid!], true, Math.min(5000, remaining));
        expect(ownedTree.some((row) => row.pid === gitChild!.pid)).toBe(true);
        expect(ownedTree.some((row) => row.pid === pids!.owner)).toBe(true);
        expect(ownedTree.some((row) => row.pid === pids!.descendant)).toBe(true);
        expect(ownedTree.every((row) => isProcessRunning(row.pid))).toBe(true);
        expect(performance.now() - gitCommandStartedAt).toBeLessThan(10_000);
        recordOwnership("ready", startedAt, {
          gitPid: gitChild!.pid,
          ownerPid: pids!.owner,
          descendantPid: pids!.descendant,
          ownedTree,
        });
        const timeoutFailure = await timedOut;
        expect(timeoutFailure).toBeInstanceOf(Error);
        expect((timeoutFailure as Error).message).toMatch(/^Git command timed out after 10000ms:/);
        expect((timeoutFailure as Error).message).not.toContain("process-tree cleanup failed");
        recordOwnership("timeout-contract", startedAt, {
          originalTimeout: true,
          cleanupFailure: false,
        });
        // Snapshot immediately at public result settlement, before any fixture cleanup.
        const atSettlement = {
          gitAlive: isProcessRunning(gitChild!.pid!),
          ownerAlive: isProcessRunning(pids!.owner),
          descendantAlive: isProcessRunning(pids!.descendant),
        };
        recordOwnership("settlement", startedAt, atSettlement);
        expect(atSettlement, "Git timeout ownership: owners alive at public settlement").toEqual({
          gitAlive: false,
          ownerAlive: false,
          descendantAlive: false,
        });
        try {
          rmSync(repo, { recursive: true, force: true });
        } catch (error) {
          recordOwnership("cwd-delete", startedAt, {
            removed: false,
            code: error instanceof Error && "code" in error ? error.code : "unknown",
          });
          if (error instanceof Error && "code" in error && error.code === "EBUSY") {
            throw new Error("Git timeout ownership: cwd EBUSY before cleanup", { cause: error });
          }
          throw error;
        }
        expect(existsSync(repo)).toBe(false);
        recordOwnership("cwd-delete", startedAt, { removed: true });
      } catch (error) {
        failure = error;
        caseFailed = true;
      } finally {
        // Await this owned command even after readiness failure, then recover late PID publication.
        await timedOut;
        try {
          observation.mockRestore();
        } catch (error) {
          cleanupErrors.push(error);
        }
        const cleanup = await cleanupWindowsOwners(pidFile, pids, gitChild, ownedTree);
        cleanupErrors.push(...cleanup.errors);
        let cwdReleased = false;
        try {
          cwdReleased = releaseWindowsFixtureCwd(repo);
          const index = tempDirs.indexOf(repo);
          if (index >= 0) tempDirs.splice(index, 1);
        } catch (error) {
          cleanupErrors.push(error);
        }
        recordOwnership("cleanup", startedAt, {
          ownedPids: cleanup.owned,
          cwdReleased,
          errors: cleanupErrors.length,
        });
      }
      if (cleanupErrors.length)
        throw new AggregateError(
          caseFailed ? [failure, ...cleanupErrors] : cleanupErrors,
          "Owned Windows Git/helper cleanup failed",
        );
      if (caseFailed) throw failure;
    },
  );
});
