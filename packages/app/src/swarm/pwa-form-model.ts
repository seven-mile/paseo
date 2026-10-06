import { z } from "zod";

export const pwaSourceSchema = z.object({ path: z.string().nullable() });
export const savedPwaSourceSchema = z.object({ path: z.string() });
export type PwaSource = z.infer<typeof pwaSourceSchema>;

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
    const canEdit = next.status.kind !== "pending";
    const trimmedPath = next.path.trim();
    state = {
      ...next,
      canSubmit: canEdit && trimmedPath.length > 0 && trimmedPath !== next.savedPath,
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
        const savedPath = saved.path ?? "";
        publish({
          ...state,
          path: savedPath,
          savedPath,
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
