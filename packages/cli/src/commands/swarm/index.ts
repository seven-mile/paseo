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
  swarmId?: string;
  // Null until the seat's first message starts its agent.
  paseoAgentId: string | null;
  name: string;
  qualifiedName?: string;
  roleClass: string;
  role: string;
  agentConfig?: AgentConfig;
  occupant?: { number: number; config: AgentConfig };
  pending: { kind: string; reason: string } | null;
}

interface SeatRow {
  seat: string;
  swarm: string;
  role: string;
  occupant: number | string;
  agent: string;
  wants: string;
  applied: string;
  pending: string;
  source: Seat;
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
    swarm: seat.swarmId ?? "-",
    role: `${seat.roleClass}/${seat.role}`,
    occupant: seat.paseoAgentId === null ? "-" : (seat.occupant?.number ?? 1),
    agent: seat.paseoAgentId ?? "-",
    wants: configSummary(seat.agentConfig),
    applied: configSummary(seat.occupant?.config),
    pending: seat.pending ? `${seat.pending.kind}: ${seat.pending.reason}` : "-",
    source: seat,
  };
}

const seatSchema: OutputSchema<SeatRow> = {
  idField: "seat",
  columns: [
    { header: "SEAT", field: "seat" },
    { header: "SWARM", field: "swarm" },
    { header: "ROLE", field: "role" },
    { header: "OCCUPANT", field: "occupant", align: "right" },
    { header: "AGENT", field: "agent" },
    { header: "WANTS", field: "wants" },
    { header: "APPLIED", field: "applied" },
    {
      header: "PENDING",
      field: "pending",
      color: (value) => (value === "-" ? undefined : "yellow"),
    },
  ],
  // JSON and YAML get the seat as the daemon returns it, with its plan as { kind, reason }.
  serialize: (row) => row.source,
};

const historySchema: OutputSchema<HistoryEntryRow> = {
  idField: "type",
  columns: [
    { header: "TYPE", field: "type" },
    { header: "TEXT", field: "text" },
  ],
};

// Seat names are unique only within a swarm; --swarm names the swarm when several use one name.
interface SwarmOptions extends CommandOptions {
  swarm?: string;
}

async function invokeSwarm(
  options: SwarmOptions,
  method: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const client = await connectToDaemon({ target: options.daemonTarget });
  try {
    return await client.invokePluginRpc(SWARM_PLUGIN, method, {
      ...input,
      ...(options.swarm ? { swarmId: options.swarm } : {}),
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function seatList(method: string, input: Record<string, unknown>, options: SwarmOptions) {
  const { seats } = (await invokeSwarm(options, method, input)) as { seats: Seat[] };
  return { type: "list", data: seats.map(toSeatRow), schema: seatSchema } as ListResult<SeatRow>;
}

interface LsOptions extends SwarmOptions {
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

interface SetOptions extends SwarmOptions {
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

interface ResetOptions extends SwarmOptions {
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

interface HistoryOptions extends SwarmOptions {
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

// What `swarm diff` and `swarm up` report: the plugin's roster plan.
export interface RosterPlan {
  reserve: Array<{ seat: string; role: string }>;
  restore: Array<{ seat: string; changes: string[] }>;
  update: Array<{ seat: string; changes: string[] }>;
  retire: Array<{ seat: string; tasks: string[]; queuedMessages: number }>;
  source: { files: string[]; prompts: string[] } | null;
  refusals: string[];
}

interface SwarmSummary {
  id: string;
  name: string;
  directory: string;
  projectId: string | null;
  revision: string;
}

export function planLines(plan: RosterPlan): string[] {
  const changes = (list: string[]) => (list.length > 0 ? `: ${list.join(", ")}` : "");
  const lines = [
    ...plan.reserve.map((entry) => `+ ${entry.seat} (${entry.role}), starts on first mail`),
    ...plan.restore.map((entry) => `↺ ${entry.seat} comes back${changes(entry.changes)}`),
    ...plan.update.map((entry) => `~ ${entry.seat}${changes(entry.changes)}`),
    ...plan.retire.map((entry) => {
      const notes = [
        entry.tasks.length > 0 ? `named by Tasks ${entry.tasks.join(", ")}` : null,
        entry.queuedMessages > 0 ? `${entry.queuedMessages} queued messages fail` : null,
      ].filter((note): note is string => note !== null);
      return `- ${entry.seat} retires${notes.length > 0 ? ` (${notes.join("; ")})` : ""}`;
    }),
  ];
  if (plan.source) {
    lines.push(`PWA: ${plan.source.files.join(", ")}`);
    if (plan.source.prompts.length > 0) {
      lines.push(`  new standing prompt at next mail for ${plan.source.prompts.join(", ")}`);
    }
  }
  lines.push(...plan.refusals.map((refusal) => `refused: ${refusal}`));
  return lines;
}

interface DirectoryUp {
  swarm: SwarmSummary;
  plan: RosterPlan;
}

function upSchema(applied: boolean): OutputSchema<DirectoryUp> {
  return {
    idField: (result) => result.swarm.id,
    columns: [],
    renderHuman: (result) => {
      const { swarm, plan } = result.type === "single" ? result.data : result.data[0];
      const lines = planLines(plan);
      if (lines.length === 0) return `${swarm.directory} matches what swarm ${swarm.id} accepted.`;
      const heading = applied
        ? `Accepted ${swarm.directory}. Agents catch up at their next mail.`
        : `swarm up would accept from ${swarm.directory}:`;
      return [heading, ...lines].join("\n");
    },
  };
}

interface ScopeOptions extends SwarmOptions {
  project?: string;
}

const scope = (options: ScopeOptions) => (options.project ? { projectId: options.project } : {});

async function runDirectoryUp(
  dryRun: boolean,
  options: ScopeOptions,
): Promise<SingleResult<DirectoryUp>> {
  const data = (await invokeSwarm(options, "swarm.directory.up", {
    ...scope(options),
    dryRun,
  })) as DirectoryUp;
  return { type: "single", data, schema: upSchema(!dryRun) };
}

interface SwarmStatus {
  swarm: SwarmSummary;
  unapplied: RosterPlan | null;
  invalid: string | null;
  recovery?: string | null;
  seats: Seat[];
}

function directoryLines(status: SwarmStatus): string[] {
  const { directory } = status.swarm;
  if (status.recovery) {
    return [
      `Seat changes are on hold: ${status.recovery}`,
      "Run `paseo-swarm swarm recover --keep-file` or `--apply-intent`.",
    ];
  }
  if (status.invalid) return [`${directory} cannot be accepted: ${status.invalid}`];
  if (!status.unapplied) return [`${directory} matches what the swarm accepted.`];
  return [`Unapplied changes in ${directory}:`, ...planLines(status.unapplied)];
}

const statusSchema: OutputSchema<SwarmStatus> = {
  idField: (status) => status.swarm.id,
  columns: [],
  renderHuman: (result, options) => {
    const status = result.type === "single" ? result.data : result.data[0];
    const directory = directoryLines(status);
    const seats = renderTable<SeatRow>(
      { type: "list", data: status.seats.map(toSeatRow), schema: seatSchema },
      options,
    );
    return [`Swarm ${status.swarm.id}`, ...directory, "", seats].join("\n");
  },
};

async function runStatus(
  options: ScopeOptions,
  _command: Command,
): Promise<SingleResult<SwarmStatus>> {
  const data = (await invokeSwarm(options, "swarm.status.read", scope(options))) as SwarmStatus;
  return { type: "single", data, schema: statusSchema };
}

interface RecoverOptions extends ScopeOptions {
  keepFile?: boolean;
  applyIntent?: boolean;
}

interface Recovered {
  swarm: SwarmSummary;
  seats: string[];
}

async function runRecover(
  options: RecoverOptions,
  _command: Command,
): Promise<SingleResult<Recovered>> {
  if (!options.keepFile === !options.applyIntent) {
    throw new Error("Pass one of --keep-file or --apply-intent");
  }
  const keep = options.keepFile ? "file" : "intent";
  const data = (await invokeSwarm(options, "swarm.directory.recover", {
    ...scope(options),
    keep,
  })) as Recovered;
  const schema: OutputSchema<Recovered> = {
    idField: (result) => result.swarm.id,
    columns: [],
    renderHuman: () =>
      keep === "file"
        ? `Kept ${data.swarm.directory}/swarm.yaml as it is; the change to ${data.seats.join(", ")} was dropped.`
        : `Applied the change to ${data.seats.join(", ")} to swarm.yaml and accepted it.`,
  };
  return { type: "single", data, schema };
}

async function runRetire(
  seat: string,
  options: SwarmOptions,
  _command: Command,
): Promise<ListResult<SeatRow>> {
  const { seat: retired } = (await invokeSwarm(options, "swarm.seat.retire", { seat })) as {
    seat: Seat;
  };
  return { type: "list", data: [toSeatRow(retired)], schema: seatSchema };
}

function addSeatOptions(command: Command): Command {
  return addJsonAndDaemonHostOptions(
    command.option("--swarm <id>", "The swarm whose seats to use, from the SWARM column of ls"),
  );
}

export function createSwarmCommand(): Command {
  const swarm = new Command("swarm").description("Manage the Swarm plugin");
  addSeatOptions(
    swarm
      .command("diff")
      .description("Show what up would accept from the swarm directory, and what each change costs")
      .option("--project <id>", "The swarm of this project"),
  ).action(withOutput((options: ScopeOptions, _command: Command) => runDirectoryUp(true, options)));
  addSeatOptions(
    swarm
      .command("up")
      .description(
        "Accept the swarm directory: swarm.yaml, PWA.md and roles/. Agents are not touched; each seat's next mail brings its agent in line",
      )
      .option("--project <id>", "The swarm of this project"),
  ).action(
    withOutput((options: ScopeOptions, _command: Command) => runDirectoryUp(false, options)),
  );
  addSeatOptions(
    swarm
      .command("status")
      .description(
        "Show unapplied changes in the swarm directory and the work pending for each seat",
      )
      .option("--project <id>", "The swarm of this project"),
  ).action(withOutput(runStatus));
  addSeatOptions(
    swarm
      .command("recover")
      .description(
        "Resolve a seat change that a crash left half written while swarm.yaml was edited by hand",
      )
      .option("--project <id>", "The swarm of this project")
      .option("--keep-file", "Keep swarm.yaml as it is and drop the change")
      .option("--apply-intent", "Apply the change to swarm.yaml and accept it"),
  ).action(withOutput(runRecover));
  const seat = swarm
    .command("seat")
    .description(
      "Manage Swarm seats: the roster identities whose Paseo agents can be replaced. A seat's next Swarm mailbox delivery, after any running turn, brings its agent in line with the seat: in place where the context survives, otherwise with an earlier or a new agent. Changes made in the agent's own chat are left alone until then.",
    );
  addSeatOptions(
    seat
      .command("ls")
      .description(
        "List seats with the config they want, what Swarm last gave their agent, and the change pending",
      )
      .option("--project <id>", "Only seats in this project")
      .option("-a, --all", "Include retired seats"),
  ).action(withOutput(runLs));
  addSeatOptions(
    seat
      .command("set")
      .description(
        "Change the agent config seats want; their agents follow at each seat's next Swarm mailbox delivery",
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
  addSeatOptions(
    seat
      .command("reset")
      .description(
        "Replace seats' agents with fresh ones before their next Swarm mailbox delivery, keeping their config",
      )
      .argument("<seats...>", "Seat qualified names or roster IDs")
      .option("--cancel", "Withdraw a reset that has not taken effect")
      .option("--dry-run", "Show the result without saving it"),
  ).action(withOutput(runReset));
  addSeatOptions(
    seat
      .command("retire")
      .description(
        "Retire a seat that has no active team: it leaves swarm.yaml, its queued mail fails, and its agent and history are kept",
      )
      .argument("<seat>", "Seat qualified name or roster ID"),
  ).action(withOutput(runRetire));
  addSeatOptions(
    seat
      .command("history")
      .description("Read the transcript of a seat's agent, newest first")
      .argument("<seat>", "Seat qualified name or roster ID")
      .option("--occupant <n>", "Occupant number (default: the current one)")
      .option("--before <cursor>", "Cursor from a previous page")
      .option("--limit <n>", "Entries per page (default: 40)"),
  ).action(withOutput(runHistory));
  return swarm;
}
