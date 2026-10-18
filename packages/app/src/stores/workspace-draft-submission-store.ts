import type { CreateAgentRequestOptions } from "@getpaseo/client/internal/daemon-client";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { create } from "zustand";
import type { ComposerAttachment } from "@/attachments/types";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export interface PendingWorkspaceDraftSubmission {
  /** Already-running creation. Mounting the draft only observes its result. */
  agentCreation?: {
    result: Promise<AgentSnapshotPayload>;
    retry: (input: CreateAgentRequestOptions) => Promise<AgentSnapshotPayload>;
  };
  serverId: string;
  workspaceId: string;
  draftId: string;
  text: string;
  attachments: ComposerAttachment[];
  cwd: string;
  provider: AgentProvider;
  clientMessageId: string;
  timestamp: number;
  modeId?: string;
  model?: string;
  thinkingOptionId?: string;
  featureValues?: Record<string, unknown>;
  allowEmptyText?: boolean;
}

export interface PendingWorkspaceDraftSetup {
  setup: WorkspaceDraftTabSetup;
  sourceDirectory?: string | null;
}

export interface SwarmWorkspaceDraft {
  form: ReturnType<typeof import("@/swarm/parent-selection").openSwarmCreationFormDraft>;
  preparation: ReturnType<typeof import("@/swarm/parent-selection").openSwarmPreparation>;
  worktreeSlug: string;
}

interface WorkspaceDraftSubmissionState {
  pendingByDraftId: Record<string, PendingWorkspaceDraftSubmission>;
  swarmByDraftId: Record<string, SwarmWorkspaceDraft>;
  retainSwarmDraft: (input: {
    draftId: string;
    create: () => SwarmWorkspaceDraft;
  }) => SwarmWorkspaceDraft;
  clearSwarmDraft: (input: { draftId: string }) => void;
  setupByDraftId: Record<string, PendingWorkspaceDraftSetup>;
  creationByDraftId: Record<string, NonNullable<PendingWorkspaceDraftSubmission["agentCreation"]>>;
  setPending: (submission: PendingWorkspaceDraftSubmission) => void;
  setDraftSetup: (input: {
    draftId: string;
    setup: WorkspaceDraftTabSetup;
    sourceDirectory?: string | null;
  }) => void;
  clearDraftSetup: (input: { draftId: string }) => void;
  consumePending: (input: {
    serverId: string;
    workspaceId: string;
    draftId: string;
  }) => PendingWorkspaceDraftSubmission | null;
}

function matchesPendingSubmission(
  pending: PendingWorkspaceDraftSubmission | null | undefined,
  input: { serverId: string; workspaceId: string; draftId: string },
): pending is PendingWorkspaceDraftSubmission {
  return (
    pending?.serverId === input.serverId &&
    pending.workspaceId === input.workspaceId &&
    pending.draftId === input.draftId
  );
}

function normalizeDraftId(draftId: string): string {
  return draftId.trim();
}

export const useWorkspaceDraftSubmissionStore = create<WorkspaceDraftSubmissionState>(
  (set, get) => ({
    pendingByDraftId: {},
    swarmByDraftId: {},
    retainSwarmDraft: ({ draftId, create: createDraft }) => {
      const existing = get().swarmByDraftId[draftId];
      if (existing) return existing;
      const draft = createDraft();
      set((state) => ({ swarmByDraftId: { ...state.swarmByDraftId, [draftId]: draft } }));
      return draft;
    },
    clearSwarmDraft: ({ draftId }) =>
      set((state) => {
        if (!state.swarmByDraftId[draftId]) return state;
        const swarmByDraftId = { ...state.swarmByDraftId };
        delete swarmByDraftId[draftId];
        return { swarmByDraftId };
      }),
    setupByDraftId: {},
    creationByDraftId: {},
    setPending: (submission) =>
      set((state) => ({
        creationByDraftId: submission.agentCreation
          ? { ...state.creationByDraftId, [submission.draftId]: submission.agentCreation }
          : state.creationByDraftId,
        pendingByDraftId: {
          ...state.pendingByDraftId,
          [submission.draftId]: submission,
        },
      })),
    setDraftSetup: ({ draftId, setup, sourceDirectory }) => {
      const normalizedDraftId = normalizeDraftId(draftId);
      if (!normalizedDraftId) return;
      set((state) => ({
        setupByDraftId: {
          ...state.setupByDraftId,
          [normalizedDraftId]: { setup, sourceDirectory: sourceDirectory ?? null },
        },
      }));
    },
    clearDraftSetup: ({ draftId }) => {
      const normalizedDraftId = normalizeDraftId(draftId);
      if (!normalizedDraftId) return;
      set((state) => {
        const swarmByDraftId = { ...state.swarmByDraftId };
        delete swarmByDraftId[normalizedDraftId];
        const creationByDraftId = { ...state.creationByDraftId };
        delete creationByDraftId[normalizedDraftId];
        const { [normalizedDraftId]: _removed, ...setupByDraftId } = state.setupByDraftId;
        return { setupByDraftId, creationByDraftId, swarmByDraftId };
      });
    },
    consumePending: (input) => {
      const pending = get().pendingByDraftId[input.draftId];
      if (!matchesPendingSubmission(pending, input)) {
        return null;
      }
      set((state) => {
        if (!matchesPendingSubmission(state.pendingByDraftId[input.draftId], input)) {
          return state;
        }
        // Expo miscompiles computed member-key rest omissions; test the emitted code.
        const pendingByDraftId = { ...state.pendingByDraftId };
        delete pendingByDraftId[input.draftId];
        return { pendingByDraftId };
      });
      return pending;
    },
  }),
);
