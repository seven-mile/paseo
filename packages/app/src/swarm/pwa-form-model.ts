import { z } from "zod";

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
  defaultPwa: z.string().nullable().optional(),
});
// COMPAT(swarm-pwa-discovery): path-only hosts predate multi-PWA discovery; added in v0.11, remove after 2027-04-17.
export const pwaSourceSchema = z
  .object({
    path: z.string().nullable(),
    defaultPwa: z.string().nullable().optional(),
    sourcePreview: z.boolean().optional(),
    entries: z.array(pwaEntrySchema).optional(),
    complete: z.boolean().optional(),
    errors: z.array(z.object({ directory: z.string(), error: z.string() })).optional(),
    rootError: z.string().optional(),
  })
  .transform((source) => ({
    ...source,
    defaultPwa: source.defaultPwa ?? null,
    entries: source.entries ?? [],
    complete: source.complete ?? false,
    errors: source.errors ?? [],
    discoveryAvailable: source.entries !== undefined,
  }));
export interface PwaSource {
  path: string | null;
  defaultPwa?: string | null;
}
export type PwaDiscovery = z.infer<typeof pwaSourceSchema>;
export type PwaEntry = z.infer<typeof pwaEntrySchema>;

export function hasRootPwa(source: PwaDiscovery | undefined): boolean {
  if (!source?.path || source.rootError) return false;
  if (!source.discoveryAvailable) return true;
  return source.entries.some((entry) => entry.directory === "." && !entry.error);
}

export function initialPwaDirectory(source: PwaDiscovery): string | null {
  if (source.defaultPwa !== null) return source.defaultPwa;
  return hasRootPwa(source) ? "." : null;
}

export function getPwaDefaultChoices(entries: readonly PwaEntry[], selected: string) {
  const choices: Array<{ directory: string; title: string; available: boolean; error?: string }> = [
    { directory: "", title: "", available: true },
    ...entries.map((entry) => ({
      directory: entry.directory,
      title: entry.title,
      available: !entry.error,
      ...(entry.error ? { error: entry.error } : {}),
    })),
  ];
  if (selected && !entries.some((entry) => entry.directory === selected)) {
    choices.push({ directory: selected, title: selected, available: false });
  }
  return choices;
}

export function getPwaSourceSaveFields(
  source: PwaDiscovery,
  path: string,
  defaultPwa: string | null,
) {
  const canSaveDefault =
    source.discoveryAvailable &&
    (source.sourcePreview === true || path.trim() === (source.path ?? "").trim());
  return { path, ...(canSaveDefault ? { defaultPwa } : {}) };
}

export type PwaPreviewState =
  | { kind: "unsupported" }
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; source: PwaDiscovery }
  | { kind: "error"; message: string };

export type PwaFormStatus =
  | { kind: "editing" }
  | { kind: "pending" }
  | { kind: "success" }
  | { kind: "error"; message: string };

export interface PwaFormState {
  path: string;
  savedPath: string;
  defaultPwa: string;
  savedDefaultPwa: string;
  status: PwaFormStatus;
  canSubmit: boolean;
  inputRevision: number;
  preview: PwaPreviewState;
}

export interface PwaFormSnapshot {
  path: string | null;
  defaultPwa?: string | null;
  discovery?: PwaDiscovery;
  preview?(path: string): Promise<PwaDiscovery>;
  save(path: string, defaultPwa: string | null): Promise<PwaSource>;
}

export function openPwaForm(snapshot: PwaFormSnapshot) {
  const listeners = new Set<() => void>();
  let closed = false;
  let previewGeneration = 0;
  const initialPath = snapshot.path ?? "";
  let state: PwaFormState = {
    path: initialPath,
    savedPath: initialPath,
    defaultPwa: snapshot.defaultPwa ?? "",
    savedDefaultPwa: snapshot.defaultPwa ?? "",
    status: { kind: "editing" },
    canSubmit: false,
    inputRevision: 0,
    preview: snapshot.discovery ? { kind: "loaded", source: snapshot.discovery } : { kind: "idle" },
  };
  function publish(next: PwaFormState) {
    if (closed) return;
    const canEdit = next.status.kind !== "pending";
    const trimmedPath = next.path.trim();
    const validDefault =
      next.preview.kind === "unsupported" ||
      !snapshot.preview ||
      (next.preview.kind === "loaded" &&
        !next.preview.source.rootError &&
        getPwaDefaultChoices(next.preview.source.entries, next.defaultPwa).some(
          (choice) => choice.directory === next.defaultPwa && choice.available,
        ));
    state = {
      ...next,
      canSubmit:
        canEdit &&
        trimmedPath.length > 0 &&
        validDefault &&
        (trimmedPath !== next.savedPath || next.defaultPwa.trim() !== next.savedDefaultPwa),
    };
    for (const listener of listeners) listener();
  }
  async function refreshPreview() {
    if (closed || !snapshot.preview) return;
    const generation = ++previewGeneration;
    const path = state.path.trim();
    if (!path) {
      publish({ ...state, preview: { kind: "idle" } });
      return;
    }
    // COMPAT(swarm-pwa-preview): discovery alone does not imply draft-root preview; added in v0.11, remove after 2027-04-17.
    if (
      snapshot.discovery &&
      snapshot.discovery.sourcePreview !== true &&
      path !== initialPath.trim()
    ) {
      publish({ ...state, preview: { kind: "unsupported" } });
      return;
    }
    publish({ ...state, preview: { kind: "loading" } });
    try {
      const source = await snapshot.preview(path);
      if (closed || generation !== previewGeneration) return;
      publish({ ...state, preview: { kind: "loaded", source } });
    } catch (error) {
      if (closed || generation !== previewGeneration) return;
      publish({
        ...state,
        preview: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }
  return {
    refreshPreview,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      closed = true;
      listeners.clear();
      previewGeneration += 1;
    },
    setPath(path: string) {
      if (closed || state.status.kind === "pending") return;
      publish({
        ...state,
        path,
        status: { kind: "editing" },
        preview: snapshot.preview ? { kind: "loading" } : state.preview,
      });
      void refreshPreview();
    },
    setDefaultPwa(defaultPwa: string) {
      if (closed || state.status.kind === "pending" || state.preview.kind === "unsupported") return;
      publish({ ...state, defaultPwa, status: { kind: "editing" } });
    },
    async submit() {
      if (closed || !state.canSubmit) return;
      publish({ ...state, status: { kind: "pending" } });
      try {
        const saved = await snapshot.save(state.path.trim(), state.defaultPwa.trim() || null);
        const savedPath = saved.path ?? "";
        publish({
          ...state,
          path: savedPath,
          savedPath,
          defaultPwa: saved.defaultPwa ?? "",
          savedDefaultPwa: saved.defaultPwa ?? "",
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
