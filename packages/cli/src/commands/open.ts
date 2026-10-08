import type { AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";

export function rejectDesktopLaunch(): never {
  throw Object.assign(new Error("paseo-swarm does not launch Desktop. Connect using the Web UI."), {
    code: "DESKTOP_UNSUPPORTED",
  });
}

export async function openDesktopWithProject(_projectPath: string): Promise<void> {
  try {
    rejectDesktopLaunch();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}

export async function openDesktopWithAgent(_target: AgentDeepLinkTarget): Promise<void> {
  rejectDesktopLaunch();
}
