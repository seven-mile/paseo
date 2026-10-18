import { z } from "zod";
import type { ProjectSelection } from "@/screens/new-workspace/project-selection";
import {
  initialPickerSelectionState,
  reducePickerSelection,
  type PickerSelectionEvent,
  type PickerSelectionState,
} from "@/screens/new-workspace-picker-state";
import { hasRootPwa, type PwaDiscovery } from "./pwa-form-model";

export type SwarmCreationLoadState =
  | "missing-project"
  | "not-installed"
  | "pending"
  | "error"
  | "loaded";

export function getSwarmCreationLoadKey(
  loadState: SwarmCreationLoadState,
  roles: readonly { role: string }[],
) {
  switch (loadState) {
    case "missing-project":
      return "swarm.creation.chooseProject";
    case "not-installed":
      return "swarm.creation.notInstalled";
    case "pending":
      return "swarm.creation.waitRoles";
    case "error":
      return null;
    case "loaded":
      return roles.length === 0 ? "swarm.creation.noRoles" : null;
  }
}

export function getSwarmCreationValidationKey(input: {
  loadState: SwarmCreationLoadState;
  roleClass: "planner" | "supervisor" | "worker";
  roles: readonly { role: string }[];
  role: string;
  parents: readonly SwarmParentChoice[];
  reportsTo: string | null;
}) {
  const loadKey = getSwarmCreationLoadKey(input.loadState, input.roles);
  if (loadKey || input.loadState !== "loaded") return loadKey;
  if (!input.roles.some((choice) => choice.role === input.role)) return "swarm.creation.chooseRole";
  if (
    input.roleClass !== "planner" &&
    !input.parents.some((choice) => choice.name === input.reportsTo)
  )
    return "swarm.creation.chooseManager";
  return null;
}

export interface SwarmParentChoice {
  name: string;
  title: string;
  displayName: string;
  paseoAgentId: string;
  serverId: string;
  workspaceId: string | null;
  pwaBinding?: { projectId?: string; contentRoot: string; directory: string };
}

export function filterSwarmParents(
  parents: readonly SwarmParentChoice[],
  roleClass: "planner" | "supervisor" | "worker",
  serverId: string,
  workspaceKeys: readonly string[],
) {
  return parents.filter(
    (parent) =>
      parent.serverId === serverId &&
      (roleClass === "planner" ||
        (parent.workspaceId !== null &&
          workspaceKeys.includes(`${serverId}:${parent.workspaceId}`))),
  );
}

export function resolveSwarmParent(parents: readonly SwarmParentChoice[], selected: string | null) {
  return parents.some((parent) => parent.name === selected) ? selected : (parents[0]?.name ?? null);
}

function resolveInheritedPwaSelection(
  source: PwaDiscovery | undefined,
  parent: SwarmParentChoice | undefined,
  rootPwa: boolean,
) {
  const boundDirectory = parent?.pwaBinding?.directory;
  return {
    canReadRoles: Boolean(parent && (boundDirectory || rootPwa)),
    inheritedDirectory:
      boundDirectory ?? (parent && rootPwa ? (source?.path ?? undefined) : undefined),
  };
}

function hasConfirmedMissingRootPwa(source: PwaDiscovery | undefined) {
  const rootEntry = source?.entries.find((choice) => choice.directory === ".");
  const rootUnavailable = source?.complete === true || Boolean(rootEntry?.error);
  return Boolean(source?.discoveryAvailable && !source.rootError && rootUnavailable);
}

export function resolveSwarmPwaSelection(
  source: PwaDiscovery | undefined,
  roleClass: "planner" | "supervisor" | "worker",
  parent: SwarmParentChoice | undefined,
  directory: string,
) {
  const inherited = roleClass !== "planner";
  const entry = source?.entries.find((choice) => choice.directory === directory);
  const rootPwa = hasRootPwa(source);
  let canReadRoles = Boolean(entry && !entry.error && !source?.rootError);
  let inheritedDirectory: string | undefined;
  if (!source?.discoveryAvailable && rootPwa && directory === ".") canReadRoles = true;
  if (inherited) {
    const inheritedSelection = resolveInheritedPwaSelection(source, parent, rootPwa);
    canReadRoles = inheritedSelection.canReadRoles;
    inheritedDirectory = inheritedSelection.inheritedDirectory;
  }
  const needsBinding = Boolean(
    inherited && parent && !canReadRoles && hasConfirmedMissingRootPwa(source),
  );
  return { inherited, entry, canReadRoles, inheritedDirectory, needsBinding };
}

export interface SwarmCreationDraftContext {
  key: string;
  serverId: string;
  roleClass: "planner" | "supervisor" | "worker";
  hasProject: boolean;
}

export interface SwarmCreationDraft extends SwarmCreationDraftContext {
  hasResolvedProject: boolean;
  directory: string | null | undefined;
  role: string;
  parent: string | null;
}

export function changeSwarmCreationParent(
  draft: SwarmCreationDraft,
  parent: string,
): SwarmCreationDraft {
  return draft.parent === parent ? draft : { ...draft, parent, role: "" };
}

export interface SwarmCreationFormSnapshot {
  name: string;
  selection: SwarmCreationDraft | null;
  manualHost: { routeServerId: string; serverId: string } | null;
  projectSelection: ProjectSelection | null;
  isolation: "local" | "worktree" | null;
  checkout: { targetKey: string; picker: PickerSelectionState } | null;
}

export function resolveSwarmCheckoutSelection(
  checkout: SwarmCreationFormSnapshot["checkout"],
  targetKey: string,
): PickerSelectionState {
  return checkout?.targetKey === targetKey ? checkout.picker : initialPickerSelectionState;
}

// The existing workspace draft owner retains this model through responsive route remounts.
export function openSwarmCreationFormDraft(name: string) {
  let snapshot: SwarmCreationFormSnapshot = {
    name,
    selection: null,
    manualHost: null,
    projectSelection: null,
    isolation: null,
    checkout: null,
  };
  const listeners = new Set<() => void>();
  const publish = (next: SwarmCreationFormSnapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setName(nextName: string) {
      if (snapshot.name !== nextName) publish({ ...snapshot, name: nextName });
    },
    setSelection(selection: SwarmCreationDraft) {
      if (snapshot.selection !== selection) publish({ ...snapshot, selection });
    },
    setHost(manualHost: NonNullable<SwarmCreationFormSnapshot["manualHost"]>) {
      publish({ ...snapshot, manualHost });
    },
    setProjectSelection(projectSelection: ProjectSelection) {
      publish({ ...snapshot, projectSelection });
    },
    setIsolation(isolation: "local" | "worktree") {
      if (snapshot.isolation !== isolation) publish({ ...snapshot, isolation });
    },
    dispatchCheckout(targetKey: string, event: PickerSelectionEvent) {
      const previous =
        snapshot.checkout?.targetKey === targetKey
          ? snapshot.checkout.picker
          : initialPickerSelectionState;
      publish({
        ...snapshot,
        checkout: { targetKey, picker: reducePickerSelection(previous, event) },
      });
    },
  };
}

export function reconcileSwarmCreationDraft(
  draft: SwarmCreationDraft,
  context: SwarmCreationDraftContext,
): SwarmCreationDraft {
  if (draft.key === context.key) return draft;
  const initialHydration =
    !draft.hasResolvedProject &&
    context.hasProject &&
    draft.serverId === context.serverId &&
    draft.roleClass === context.roleClass;
  return {
    ...context,
    hasResolvedProject: draft.hasResolvedProject || context.hasProject,
    directory: undefined,
    role: "",
    parent: initialHydration ? draft.parent : null,
  };
}

export function swarmPwaSourceIdentity(
  roleClass: SwarmCreationDraftContext["roleClass"],
  sourcePath: string | null | undefined,
  directory: string,
  parentBinding: SwarmParentChoice["pwaBinding"],
) {
  if (roleClass === "planner") return JSON.stringify(["planner", sourcePath, directory]);
  if (!parentBinding) return JSON.stringify(["inherited-root", sourcePath, "."]);
  return JSON.stringify([
    "inherited",
    parentBinding.projectId,
    parentBinding.contentRoot,
    parentBinding.directory,
  ]);
}

// COMPAT(swarm-prepared-parent): added in v0.11, remove after 2027-04-17.
export const swarmPreparedAgentSchema = z.object({
  agentId: z.string(),
  systemPrompt: z.string(),
  parentAgentId: z.string().nullable().optional().default(null),
});

export interface SwarmPreparedAgent {
  agentId: string;
  systemPrompt: string;
  parentAgentId: string | null;
}

// A failed native create/bind keeps the prepared prompt and identity for this form lifetime.
export function openSwarmPreparation(onConflict: (agentId: string) => string) {
  let reservation: { key: string; result: SwarmPreparedAgent } | null = null;
  let pending: { key: string; result: Promise<SwarmPreparedAgent> } | null = null;
  return {
    async prepare(
      key: string,
      create: () => Promise<SwarmPreparedAgent>,
    ): Promise<SwarmPreparedAgent> {
      if (reservation) {
        if (reservation.key === key) return reservation.result;
        throw new Error(onConflict(reservation.result.agentId));
      }
      if (pending) {
        if (pending.key === key) return pending.result;
        const prepared = await pending.result;
        throw new Error(onConflict(prepared.agentId));
      }
      const result = create();
      pending = { key, result };
      try {
        const prepared = await result;
        reservation = { key, result: prepared };
        return prepared;
      } finally {
        pending = null;
      }
    },
  };
}
