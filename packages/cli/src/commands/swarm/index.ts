import { Command } from "commander";
import type { CommandOptions, ListResult, OutputSchema, SingleResult } from "../../output/index.js";
import { renderTable, withOutput } from "../../output/index.js";

import { connectToDaemon } from "../../utils/client.js";
import { addJsonAndDaemonHostOptions } from "../../utils/command-options.js";

const SWARM_PLUGIN = "paseo-swarm";

// The fields of a Swarm seat this command reads. The plugin's seat schema is the source.
interface AgentConfig {
  provider?: string;
  modeId?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
}

interface Seat {
  id: string;
  paseoAgentId: string;
  name: string;
  qualifiedName?: string;
  roleClass: string;
  role: string;
  agentConfig?: AgentConfig;
  occupant?: { number: number; config: AgentConfig };
  stale: string | null;
}

interface SeatRow {
  seat: string;
  role: string;
  occupant: number;
  agent: string;
  wants: string;
  runs: string;
  stale: string;
}

interface HistoryEntryRow {
  type: string;
  text: string;
}

function configSummary(config: AgentConfig | undefined): string {
  if (!config) return "-";
  const parts = [
    config.provider,
    config.modeId ? `mode=${config.modeId}` : undefined,
    config.thinkingOptionId ? `thinking=${config.thinkingOptionId}` : undefined,
    config.featureValues ? `features=${JSON.stringify(config.featureValues)}` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(" ") : "-";
}

function toSeatRow(seat: Seat): SeatRow {
  return {
    seat: seat.qualifiedName ?? seat.name,
    role: `${seat.roleClass}/${seat.role}`,
    occupant: seat.occupant?.number ?? 1,
    agent: seat.paseoAgentId,
    wants: configSummary(seat.agentConfig),
    runs: configSummary(seat.occupant?.config),
    stale: seat.stale ?? "-",
  };
}

const seatSchema: OutputSchema<SeatRow> = {
  idField: "seat",
  columns: [
    { header: "SEAT", field: "seat" },
    { header: "ROLE", field: "role" },
    { header: "OCCUPANT", field: "occupant", align: "right" },
    { header: "AGENT", field: "agent" },
    { header: "WANTS", field: "wants" },
    { header: "RUNS", field: "runs" },
    { header: "STALE", field: "stale", color: (value) => (value === "-" ? undefined : "yellow") },
  ],
};

const historySchema: OutputSchema<HistoryEntryRow> = {
  idField: "type",
  columns: [
    { header: "TYPE", field: "type" },
    { header: "TEXT", field: "text" },
  ],
};

async function invokeSwarm(
  options: CommandOptions,
  method: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    return await client.invokePluginRpc(SWARM_PLUGIN, method, input);
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function seatList(method: string, input: Record<string, unknown>, options: CommandOptions) {
  const { seats } = (await invokeSwarm(options, method, input)) as { seats: Seat[] };
  return { type: "list", data: seats.map(toSeatRow), schema: seatSchema } as ListResult<SeatRow>;
}

interface LsOptions extends CommandOptions {
  project?: string;
  all?: boolean;
}

function runLs(options: LsOptions, _command: Command): Promise<ListResult<SeatRow>> {
  return seatList(
    "swarm.seat.list",
    { ...(options.project ? { projectId: options.project } : {}), includeRetired: !!options.all },
    options,
  );
}

interface SetOptions extends CommandOptions {
  provider?: string;
  mode?: string;
  thinking?: string;
  features?: string;
  clear?: string[];
  dryRun?: boolean;
}

const CLEARABLE = {
  provider: "provider",
  mode: "modeId",
  thinking: "thinkingOptionId",
  features: "featureValues",
} as const;

function parseFeatures(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--features must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function runSet(
  seats: string[],
  options: SetOptions,
  _command: Command,
): Promise<ListResult<SeatRow>> {
  const agentConfig: Record<string, unknown> = {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.mode ? { modeId: options.mode } : {}),
    ...(options.thinking ? { thinkingOptionId: options.thinking } : {}),
    ...(options.features ? { featureValues: parseFeatures(options.features) } : {}),
  };
  for (const field of options.clear ?? []) {
    if (!(field in CLEARABLE)) {
      throw new Error(`--clear takes ${Object.keys(CLEARABLE).join(", ")}; got ${field}`);
    }
    agentConfig[CLEARABLE[field as keyof typeof CLEARABLE]] = null;
  }
  if (Object.keys(agentConfig).length === 0) {
    throw new Error("Pass --provider, --mode, --thinking, --features, or --clear");
  }
  return seatList("swarm.seat.update", { seats, agentConfig, dryRun: !!options.dryRun }, options);
}

interface ResetOptions extends CommandOptions {
  cancel?: boolean;
  dryRun?: boolean;
}

function runReset(
  seats: string[],
  options: ResetOptions,
  _command: Command,
): Promise<ListResult<SeatRow>> {
  return seatList(
    "swarm.seat.reset",
    { seats, cancel: !!options.cancel, dryRun: !!options.dryRun },
    options,
  );
}

interface HistoryOptions extends CommandOptions {
  occupant?: string;
  before?: string;
  limit?: string;
}

function positiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

export interface SeatHistory {
  seat: string;
  occupant: number;
  paseoAgentId: string;
  entries: HistoryEntryRow[];
  nextBefore: string | null;
}

// JSON and YAML get the whole page, cursor included; the table shows the entries.
export const seatHistorySchema: OutputSchema<SeatHistory> = {
  idField: "paseoAgentId",
  columns: [
    { header: "SEAT", field: "seat" },
    { header: "OCCUPANT", field: "occupant" },
    { header: "AGENT", field: "paseoAgentId" },
  ],
  renderHuman: (result, options) => {
    const history = result.type === "single" ? result.data : result.data[0];
    const table = renderTable<HistoryEntryRow>(
      { type: "list", data: history.entries, schema: historySchema },
      options,
    );
    return history.nextBefore ? `${table}\nOlder entries: --before '${history.nextBefore}'` : table;
  },
};

async function runHistory(
  seat: string,
  options: HistoryOptions,
  _command: Command,
): Promise<SingleResult<SeatHistory>> {
  const occupant = positiveInteger(options.occupant, "--occupant");
  const limit = positiveInteger(options.limit, "--limit");
  const history = (await invokeSwarm(options, "swarm.seat.history.read", {
    seat,
    ...(occupant ? { occupant } : {}),
    ...(options.before ? { before: options.before } : {}),
    ...(limit ? { limit } : {}),
  })) as SeatHistory;
  return { type: "single", data: history, schema: seatHistorySchema };
}

export function createSwarmCommand(): Command {
  const swarm = new Command("swarm").description("Manage the Swarm plugin");
  const seat = swarm
    .command("seat")
    .description(
      "Manage Swarm seats: the roster identities whose Paseo agents can be replaced. A seat whose agent no longer matches it gets a fresh agent before its next Swarm mailbox delivery, after any running turn. Typing into the agent's own conversation does not replace it.",
    );
  addJsonAndDaemonHostOptions(
    seat
      .command("ls")
      .description("List seats with the config they want, what their agent runs, and staleness")
      .option("--project <id>", "Only seats in this project")
      .option("-a, --all", "Include retired seats"),
  ).action(withOutput(runLs));
  addJsonAndDaemonHostOptions(
    seat
      .command("set")
      .description(
        "Change the agent config seats want; a mismatched agent is replaced before the seat's next Swarm mailbox delivery",
      )
      .argument("<seats...>", "Seat qualified names or roster IDs")
      .option(
        "--provider <provider>",
        "provider/model, or a bare provider to keep the current model. Moving to another provider needs provider/model and --mode; thinking and features fall back to its defaults unless you pass them",
      )
      .option("--mode <id>", "Mode ID")
      .option("--thinking <id>", "Thinking option ID")
      .option("--features <json>", "Feature values as a JSON object")
      .option(
        "--clear <field...>",
        "Stop comparing these fields: provider, mode, thinking, features",
      )
      .option("--dry-run", "Show the result without saving it"),
  ).action(withOutput(runSet));
  addJsonAndDaemonHostOptions(
    seat
      .command("reset")
      .description(
        "Replace seats' agents with fresh ones before their next Swarm mailbox delivery, keeping their config",
      )
      .argument("<seats...>", "Seat qualified names or roster IDs")
      .option("--cancel", "Withdraw a reset that has not taken effect")
      .option("--dry-run", "Show the result without saving it"),
  ).action(withOutput(runReset));
  addJsonAndDaemonHostOptions(
    seat
      .command("history")
      .description("Read an earlier agent's transcript in a seat, newest first")
      .argument("<seat>", "Seat qualified name or roster ID")
      .option("--occupant <n>", "Earlier occupant number (default: the one before the current)")
      .option("--before <cursor>", "Cursor from a previous page")
      .option("--limit <n>", "Entries per page (default: 40)"),
  ).action(withOutput(runHistory));
  return swarm;
}
