import { describe, expect, it } from "vitest";
import { openPwaForm, type PwaSource } from "./pwa-form-model";

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
