import { z } from "zod";
import equal from "fast-deep-equal";
import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";

export const pwaRoleSchema = z.object({
  role: z.string(),
  roleClass: z.enum(["planner", "supervisor", "worker"]),
  title: z.string(),
  description: z.string(),
});
export const pwaEntrySchema = z.object({
  directory: z.string(),
  title: z.string(),
  roles: z.array(pwaRoleSchema),
  statuses: z.array(z.string()),
  error: z.string().optional(),
});
export const savedPwaSourceSchema = z.object({
  path: z.string(),
});
// COMPAT(swarm-pwa-discovery): path-only hosts predate multi-PWA discovery; added in v0.11, remove after 2027-04-17.
export const pwaSourceSchema = z
  .object({
    path: z.string().nullable(),
    sourcePreview: z.boolean().optional(),
    agentConfigRead: z.boolean().optional(),
    entries: z.array(pwaEntrySchema).optional(),
    complete: z.boolean().optional(),
    errors: z.array(z.object({ directory: z.string(), error: z.string() })).optional(),
    rootError: z.string().optional(),
  })
  .transform((source) => ({
    ...source,
    entries: source.entries ?? [],
    complete: source.complete ?? false,
    errors: source.errors ?? [],
    discoveryAvailable: source.entries !== undefined,
  }));
export interface PwaSource {
  path: string | null;
}
export type PwaDiscovery = z.infer<typeof pwaSourceSchema>;
export type PwaEntry = z.infer<typeof pwaEntrySchema>;

export function hasRootPwa(source: PwaDiscovery | undefined): boolean {
  if (!source?.path || source.rootError) return false;
  if (!source.discoveryAvailable) return true;
  return source.entries.some((entry) => entry.directory === "." && !entry.error);
}

export function initialPwaDirectory(source: PwaDiscovery): string | null {
  if (!source.discoveryAvailable) return hasRootPwa(source) ? "." : null;
  if (!source.complete || source.rootError || source.errors.length || source.entries.length !== 1)
    return null;
  return source.entries[0].error ? null : source.entries[0].directory;
}

export type PwaFormStatus =
  | { kind: "editing" }
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export interface PwaFormState {
  path: string;
  savedPath: string;
  status: PwaFormStatus;
  canSubmit: boolean;
  inputRevision: number;
}

export interface PwaFormSnapshot {
  path: string | null;
  save(path: string): Promise<PwaSource>;
}

export function openPwaForm(snapshot: PwaFormSnapshot) {
  const listeners = new Set<() => void>();
  let closed = false;
  const initialPath = snapshot.path ?? "";
  let state: PwaFormState = {
    path: initialPath,
    savedPath: initialPath,
    status: { kind: "editing" },
    canSubmit: false,
    inputRevision: 0,
  };
  function publish(next: PwaFormState) {
    if (closed) return;
    state = {
      ...next,
      canSubmit:
        next.status.kind !== "pending" &&
        next.path.trim().length > 0 &&
        next.path.trim() !== next.savedPath,
    };
    for (const listener of listeners) listener();
  }
  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
    },
    setPath(path: string) {
      if (closed || state.status.kind === "pending") return;
      publish({ ...state, path, status: { kind: "editing" } });
    },
    async submit() {
      if (closed || !state.canSubmit) return;
      publish({ ...state, status: { kind: "pending" } });
      try {
        const saved = await snapshot.save(state.path.trim());
        publish({
          ...state,
          path: saved.path ?? "",
          savedPath: saved.path ?? "",
          status: { kind: "success" },
          inputRevision: state.inputRevision + 1,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({ ...state, status: { kind: "error", message } });
      }
    },
  };
}

export const swarmAgentConfigSchema = z.object({
  systemPrompt: z.string(),
  parentAgentId: z.string().nullable(),
  projectId: z.string().optional(),
  pwaBinding: z.object({
    projectId: z.string().optional(),
    contentRoot: z.string(),
    directory: z.string(),
  }),
});

export interface SwarmAgentCreationConfig {
  systemPrompt: string;
  parentAgentId: string | null;
  register(input: { agentId: string; workspaceId: string }): Promise<void>;
}

type SwarmInitialMessage = Pick<
  CreateAgentRequestOptions,
  "initialPrompt" | "images" | "attachments"
>;

export function matchesSwarmRegistrationMessage(
  original: SwarmInitialMessage,
  retry: SwarmInitialMessage,
): boolean {
  return (
    (original.initialPrompt ?? "") === (retry.initialPrompt ?? "") &&
    equal(original.images ?? [], retry.images ?? []) &&
    equal(original.attachments ?? [], retry.attachments ?? [])
  );
}

export async function readSwarmAgentCreationConfig(
  invoke: (method: string, input: unknown) => Promise<unknown>,
  input: {
    projectId: string;
    roleClass: "planner" | "supervisor" | "worker";
    name: string;
    role: string;
    reportsTo: string | null;
    pwaDirectory?: string;
    brief: string;
  },
): Promise<SwarmAgentCreationConfig> {
  const config = swarmAgentConfigSchema.parse(
    await invoke("swarm.agent.config.read", { ...input, actorPaseoAgentId: null }),
  );
  const registration = {
    name: input.name,
    role: input.role,
    roleClass: input.roleClass,
    reportsTo: input.reportsTo,
    projectId: config.projectId ?? input.projectId,
    pwaBinding: config.pwaBinding,
  };
  return {
    systemPrompt: config.systemPrompt,
    parentAgentId: config.parentAgentId,
    async register({ agentId, workspaceId }) {
      await invoke("swarm.agent.register", { ...registration, paseoAgentId: agentId, workspaceId });
    },
  };
}
