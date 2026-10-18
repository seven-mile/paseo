import { describe, expect, it } from "vitest";
import {
  openPwaForm,
  pwaSourceSchema,
  savedPwaSourceSchema,
  getPwaDefaultChoices,
  getPwaSourceSaveFields,
  initialPwaDirectory,
  type PwaSource,
} from "./pwa-form-model";

interface PendingSave {
  path: string;
  resolve(source: PwaSource): void;
  reject(error: Error): void;
}

function pendingSource() {
  const requests: PendingSave[] = [];
  return {
    requests,
    save(path: string): Promise<PwaSource> {
      return new Promise((resolve, reject) => requests.push({ path, resolve, reject }));
    },
  };
}

describe("PWA directory form", () => {
  it("locks pending saves, preserves a failed edit for retry, and reopens from the saved path", async () => {
    const source = pendingSource();
    const form = openPwaForm({ path: "/old/pwa", save: source.save });
    expect(form.getState().canSubmit).toBe(false);
    form.setPath("  roles  ");
    const firstSave = form.submit();
    expect(form.getState().status).toEqual({ kind: "pending" });
    expect(form.getState().canSubmit).toBe(false);
    form.setPath("ignored while saving");
    await form.submit();
    expect(source.requests.map((request) => request.path)).toEqual(["roles"]);
    source.requests[0].reject(new Error("Directory has no PWA"));
    await firstSave;
    expect(form.getState()).toMatchObject({
      path: "  roles  ",
      savedPath: "/old/pwa",
      status: { kind: "error", message: "Directory has no PWA" },
      canSubmit: true,
    });
    const retry = form.submit();
    source.requests[1].resolve({ path: "/project/roles" });
    await retry;
    expect(form.getState()).toMatchObject({
      path: "/project/roles",
      savedPath: "/project/roles",
      status: { kind: "success" },
      canSubmit: false,
      inputRevision: 1,
    });
    form.close();
    const reopened = openPwaForm({ path: "/project/roles", save: source.save });
    expect(reopened.getState()).toMatchObject({
      path: "/project/roles",
      status: { kind: "editing" },
      canSubmit: false,
      inputRevision: 0,
    });
  });

  it("rejects blank edits and ignores late completion after closing", async () => {
    const source = pendingSource();
    const form = openPwaForm({ path: null, save: source.save });
    form.setPath("   ");
    await form.submit();
    expect(source.requests).toEqual([]);
    form.setPath("/pwa");
    const completion = form.submit();
    const beforeClose = form.getState();
    form.close();
    source.requests[0].resolve({ path: "/pwa" });
    await completion;
    expect(form.getState()).toBe(beforeClose);
    form.setPath("/new");
    await form.submit();
    expect(source.requests.map((request) => request.path)).toEqual(["/pwa"]);
  });
  it("saves the optional relative default with the content root without discarding a failed draft", async () => {
    const requests: Array<[string, string | null]> = [];
    const form = openPwaForm({
      path: "/content",
      defaultPwa: "old",
      async save(path, directory) {
        requests.push([path, directory]);
        return { path, defaultPwa: directory };
      },
    });
    form.setDefaultPwa("  team-a  ");
    expect(form.getState().canSubmit).toBe(true);
    await form.submit();
    expect(requests).toEqual([["/content", "team-a"]]);
    expect(form.getState()).toMatchObject({
      defaultPwa: "team-a",
      savedDefaultPwa: "team-a",
      canSubmit: false,
    });
    form.setDefaultPwa("");
    await form.submit();
    expect(requests[1]).toEqual(["/content", null]);
  });
});

describe("PWA discovery compatibility and selection", () => {
  it("accepts a legacy path-only response without claiming discovered entries", () => {
    const legacy = pwaSourceSchema.parse({ path: "/old/single-pwa" });
    expect(legacy).toMatchObject({ entries: [], defaultPwa: null, discoveryAvailable: false });
    expect(initialPwaDirectory(legacy)).toBe(".");
    expect(savedPwaSourceSchema.parse({ path: "/old/single-pwa" })).toEqual({
      path: "/old/single-pwa",
    });
  });
  it("selects the valid root PWA automatically without overriding explicit defaults", () => {
    const source = pwaSourceSchema.parse({
      path: "/root",
      defaultPwa: null,
      entries: [
        { directory: ".", title: "Existing PWA", roles: [], statuses: [] },
        { directory: "team", title: "Team", roles: [], statuses: [] },
      ],
      complete: true,
      errors: [],
    });
    expect(initialPwaDirectory(source)).toBe(".");
    expect(initialPwaDirectory({ ...source, defaultPwa: "team" })).toBe("team");
    expect(
      initialPwaDirectory({ ...source, entries: [{ ...source.entries[0], error: "unreadable" }] }),
    ).toBeNull();
    expect(initialPwaDirectory({ ...source, entries: [source.entries[1]] })).toBeNull();
  });
  it("keeps invalid current defaults visible without offering them as valid choices", () => {
    const entries = [
      { directory: "team", title: "Team", roles: [], statuses: [] },
      { directory: "broken", title: "Broken", roles: [], statuses: [], error: "Unreadable" },
    ];
    expect(getPwaDefaultChoices(entries, "removed")).toEqual([
      { directory: "", title: "", available: true },
      { directory: "team", title: "Team", available: true },
      { directory: "broken", title: "Broken", available: false, error: "Unreadable" },
      { directory: "removed", title: "removed", available: false },
    ]);
  });
});

describe("PWA draft-root discovery", () => {
  it("ignores stale previews across root changes and keeps invalid defaults visible until chosen", async () => {
    const requests: Array<{
      path: string;
      resolve(source: ReturnType<typeof pwaSourceSchema.parse>): void;
    }> = [];
    const initial = pwaSourceSchema.parse({
      path: "/a",
      sourcePreview: true,
      defaultPwa: "old",
      entries: [{ directory: "old", title: "Old", roles: [], statuses: [] }],
      complete: true,
      errors: [],
    });
    const form = openPwaForm({
      path: "/a",
      defaultPwa: "old",
      discovery: initial,
      preview: (path) => new Promise((resolve) => requests.push({ path, resolve })),
      save: async (path, defaultPwa) => ({ path, defaultPwa }),
    });
    form.setPath("/b");
    expect(form.getState()).toMatchObject({ preview: { kind: "loading" }, canSubmit: false });
    form.setPath("/c");
    const current = pwaSourceSchema.parse({
      path: "/c",
      defaultPwa: null,
      entries: [{ directory: "new", title: "New", roles: [], statuses: [] }],
      complete: true,
      errors: [],
    });
    requests[1].resolve(current);
    await Promise.resolve();
    requests[0].resolve(initial);
    await Promise.resolve();
    expect(form.getState()).toMatchObject({
      path: "/c",
      defaultPwa: "old",
      preview: { kind: "loaded", source: current },
      canSubmit: false,
    });
    form.setDefaultPwa("new");
    expect(form.getState().canSubmit).toBe(true);
    await form.submit();
    expect(form.getState()).toMatchObject({
      savedPath: "/c",
      savedDefaultPwa: "new",
      status: { kind: "success" },
    });
  });
  it("preserves discovery errors for retry and never publishes a preview after close", async () => {
    let resolve!: (source: ReturnType<typeof pwaSourceSchema.parse>) => void;
    let fail = true;
    const form = openPwaForm({
      path: "/a",
      preview: async () => {
        if (fail) throw new Error("Unreadable root");
        return new Promise((complete) => {
          resolve = complete;
        });
      },
      save: async (path) => ({ path }),
    });
    form.setPath("/b");
    await Promise.resolve();
    expect(form.getState()).toMatchObject({
      preview: { kind: "error", message: "Unreadable root" },
      canSubmit: false,
    });
    fail = false;
    const pending = form.refreshPreview();
    const before = form.getState();
    form.close();
    resolve(pwaSourceSchema.parse({ path: "/b" }));
    await pending;
    expect(form.getState()).toBe(before);
  });
});

it("does not revive the first preview when the root returns to the same text", async () => {
  const pending: Array<(source: ReturnType<typeof pwaSourceSchema.parse>) => void> = [];
  const form = openPwaForm({
    path: "/initial",
    preview: () => new Promise((resolve) => pending.push(resolve)),
    save: async (path) => ({ path }),
  });
  form.setPath("/a");
  form.setPath("/b");
  form.setPath("/a");
  pending[0](pwaSourceSchema.parse({ path: "/a", entries: [], complete: true, errors: [] }));
  await Promise.resolve();
  expect(form.getState()).toMatchObject({ preview: { kind: "loading" }, canSubmit: false });
  pending[2](
    pwaSourceSchema.parse({
      path: "/a",
      entries: [],
      complete: false,
      rootError: "Root unreadable",
      errors: [],
    }),
  );
  await Promise.resolve();
  expect(form.getState()).toMatchObject({
    preview: { kind: "loaded", source: { rootError: "Root unreadable" } },
    canSubmit: false,
  });
});

describe("PWA draft preview capability", () => {
  it("keeps intermediate discovery usable only for its current root and saves a changed root without old defaults", async () => {
    const source = pwaSourceSchema.parse({
      path: "/root-a",
      defaultPwa: "team-a",
      entries: [
        { directory: "team-a", title: "Team A", roles: [], statuses: [] },
        { directory: "team-b", title: "Team B", roles: [], statuses: [] },
      ],
      complete: true,
      errors: [],
    });
    const previews: string[] = [];
    const saves: ReturnType<typeof getPwaSourceSaveFields>[] = [];
    const form = openPwaForm({
      path: source.path,
      defaultPwa: source.defaultPwa,
      discovery: source,
      preview: async (path) => {
        previews.push(path);
        return source;
      },
      save: async (path, defaultPwa) => {
        saves.push(getPwaSourceSaveFields(source, path, defaultPwa));
        return { path, defaultPwa: source.defaultPwa };
      },
    });
    form.setDefaultPwa("team-b");
    expect(form.getState().canSubmit).toBe(true);
    expect(getPwaSourceSaveFields(source, "/root-a", "team-b")).toEqual({
      path: "/root-a",
      defaultPwa: "team-b",
    });
    form.setPath("/root-b");
    expect(form.getState()).toMatchObject({
      preview: { kind: "unsupported" },
      defaultPwa: "team-b",
      canSubmit: true,
    });
    await form.refreshPreview();
    expect(previews).toEqual([]);
    form.setDefaultPwa("team-a");
    expect(form.getState().defaultPwa).toBe("team-b");
    form.setPath("/root-a");
    await Promise.resolve();
    expect(previews).toEqual(["/root-a"]);
    expect(form.getState()).toMatchObject({
      preview: { kind: "loaded", source },
      defaultPwa: "team-b",
    });
    form.setPath("/root-b");
    await form.submit();
    expect(saves).toEqual([{ path: "/root-b" }]);
  });
  it("requires an explicit boolean true capability and rejects malformed present capabilities", () => {
    const legacy = pwaSourceSchema.parse({ path: "/root" });
    expect(getPwaSourceSaveFields(legacy, "/other", null)).toEqual({ path: "/other" });
    const source = pwaSourceSchema.parse({
      path: "/root",
      sourcePreview: true,
      entries: [],
      complete: true,
    });
    expect(getPwaSourceSaveFields(source, "/other", "team-b")).toEqual({
      path: "/other",
      defaultPwa: "team-b",
    });
    expect(getPwaSourceSaveFields({ ...source, sourcePreview: false }, "/other", "team-b")).toEqual(
      { path: "/other" },
    );
    expect(() => pwaSourceSchema.parse({ path: "/root", sourcePreview: "true" })).toThrow();
  });
});
