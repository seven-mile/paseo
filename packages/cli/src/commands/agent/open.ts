import type { Command } from "commander";
import { rejectDesktopLaunch } from "../open.js";
import type { CommandOptions } from "../../output/index.js";

export function addOpenOptions(command: Command): Command {
  return command
    .description("Desktop launch is unsupported by paseo-swarm")
    .argument("<agent-id>", "Existing agent ID")
    .option("--server <server-id>", "Server ID (defaults to the local daemon)");
}

export async function runOpenCommand(
  _agentIdArg: string,
  _options: CommandOptions,
  _command: Command,
): Promise<never> {
  rejectDesktopLaunch();
}
