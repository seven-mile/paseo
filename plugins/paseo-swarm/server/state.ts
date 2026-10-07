import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyState, stateSchema, type SwarmState } from "../shared/models";

export function getStatePath(): string {
  const home = process.env.PASEO_HOME ?? process.env.PASEO_DATA_DIR ?? process.cwd();
  return join(home, "plugin-data", "paseo-swarm", "state.json");
}

export function getMcpTokenPath(): string {
  return join(dirname(getStatePath()), "mcp-tokens.json");
}

export function getConfigPath(): string {
  return join(dirname(getStatePath()), "config.json");
}

export class StateStore {
  private state: SwarmState | null = null;
  private writing: Promise<void> = Promise.resolve();

  read(): SwarmState {
    if (this.state) return this.state;
    try {
      this.state = stateSchema.parse(JSON.parse(readFileSync(getStatePath(), "utf8")));
    } catch {
      this.state = emptyState();
    }
    return this.state;
  }

  async update(mutator: (state: SwarmState) => void): Promise<SwarmState> {
    const state = this.read();
    mutator(state);
    stateSchema.parse(state);
    const path = getStatePath();
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    this.writing = this.writing.then(async () => {
      writeFileSync(temporary, JSON.stringify(state, null, 2) + "\n", "utf8");
      renameSync(temporary, path);
      return;
    });
    await this.writing;
    return state;
  }
}

export const store = new StateStore();
