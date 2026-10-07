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

import { runGitCommand } from "./run-git-command.js";
import * as gitSpawn from "./spawn.js";

const tempDirs: string[] = [];

function makeTempRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "paseo-git-shell-"));
  tempDirs.push(repo);
  return repo;
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

async function cleanupWindowsOwners(
  pidFile: string,
  pids: { owner: number; descendant: number } | undefined,
  gitPid: number | undefined,
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
      [gitPid, pids?.owner, pids?.descendant].filter(
        (pid): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0,
      ),
    ),
  ];
  // Attempt every captured PID even when another query or kill fails.
  for (const pid of owned) {
    try {
      if (isProcessRunning(pid)) process.kill(pid, "SIGKILL");
    } catch (error) {
      errors.push(error);
    }
  }
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
      const actualSpawn = gitSpawn.spawnProcess;
      const observation = vi.spyOn(gitSpawn, "spawnProcess").mockImplementation((...args) => {
        const child = actualSpawn(...args);
        if (args[0] === "git" && args[1].includes("paseo-timeout-owner")) {
          gitChild = child;
          recordOwnership("git-start", startedAt, { gitPid: child.pid });
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
        recordOwnership("ready", startedAt, {
          gitPid: gitChild!.pid,
          ownerPid: pids!.owner,
          descendantPid: pids!.descendant,
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
        const cleanup = await cleanupWindowsOwners(pidFile, pids, gitChild?.pid);
        cleanupErrors.push(...cleanup.errors);
        recordOwnership("cleanup", startedAt, {
          ownedPids: cleanup.owned,
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
