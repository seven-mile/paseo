import { describe, expect, it } from "vitest";
import {
  openPwaForm,
  pwaSourceSchema,
  savedPwaSourceSchema,
  initialPwaDirectory,
  matchesSwarmRegistrationMessage,
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
});

describe("PWA source discovery", () => {
  it("reads legacy responses and only preselects complete unique discovery", () => {
    const legacy = pwaSourceSchema.parse({ path: "/legacy" });
    expect(legacy.discoveryAvailable).toBe(false);
    expect(initialPwaDirectory(legacy)).toBe(".");
    expect(savedPwaSourceSchema.parse({ path: "/legacy" })).toEqual({ path: "/legacy" });
    const source = pwaSourceSchema.parse({
      path: "/root",
      entries: [
        { directory: "a", title: "A", roles: [], statuses: [] },
        { directory: "b", title: "B", roles: [], statuses: [] },
      ],
      complete: true,
      errors: [],
    });
    expect(initialPwaDirectory(source)).toBeNull();
    expect(initialPwaDirectory({ ...source, entries: [source.entries[1]] })).toBe("b");
    expect(
      initialPwaDirectory({ ...source, entries: [source.entries[0]], complete: false }),
    ).toBeNull();
    expect(
      initialPwaDirectory({
        ...source,
        entries: [source.entries[0]],
        errors: [{ directory: "b", error: "unreadable" }],
      }),
    ).toBeNull();
    expect(
      initialPwaDirectory({ ...source, entries: [source.entries[0]], rootError: "unreadable" }),
    ).toBeNull();
    expect(
      initialPwaDirectory({ ...source, entries: [{ ...source.entries[0], error: "unreadable" }] }),
    ).toBeNull();
  });

  it("keeps the new creation capability explicit and malformed wire fields invalid", () => {
    expect(pwaSourceSchema.parse({ path: "/root" }).agentConfigRead).toBeUndefined();
    expect(pwaSourceSchema.parse({ path: "/root", agentConfigRead: true }).agentConfigRead).toBe(
      true,
    );
    expect(() => pwaSourceSchema.parse({ path: "/root", agentConfigRead: "true" })).toThrow();
  });
});

describe("Swarm registration retry message", () => {
  const original = {
    initialPrompt: "original brief",
    images: [{ data: "original image", mimeType: "image/png" }],
    attachments: [
      {
        type: "uploaded_file" as const,
        id: "file-id",
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 4,
        path: "/uploads/notes.txt",
      },
    ],
  };

  it("allows the original message and normalizes absent empty fields", () => {
    expect(
      matchesSwarmRegistrationMessage(original, {
        ...original,
        images: original.images.map((image) => ({ ...image })),
        attachments: original.attachments.map((attachment) => ({ ...attachment })),
      }),
    ).toBe(true);
    expect(
      matchesSwarmRegistrationMessage({}, { initialPrompt: "", images: [], attachments: [] }),
    ).toBe(true);
  });

  it("rejects edited brief, image data, and full attachment metadata without changing either message", () => {
    const before = JSON.stringify(original);
    expect(
      matchesSwarmRegistrationMessage(original, { ...original, initialPrompt: "edited brief" }),
    ).toBe(false);
    expect(
      matchesSwarmRegistrationMessage(original, {
        ...original,
        images: [{ ...original.images[0], data: "edited image" }],
      }),
    ).toBe(false);
    expect(
      matchesSwarmRegistrationMessage(original, {
        ...original,
        attachments: [{ ...original.attachments[0], path: "/uploads/other.txt" }],
      }),
    ).toBe(false);
    expect(
      matchesSwarmRegistrationMessage(original, { ...original, images: [], attachments: [] }),
    ).toBe(false);
    expect(JSON.stringify(original)).toBe(before);
    expect(matchesSwarmRegistrationMessage(original, original)).toBe(true);
  });
});
