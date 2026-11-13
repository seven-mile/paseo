import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { PromptImageStore } from "./prompt-images.js";

const logger = pino({ level: "silent" });

describe("PromptImageStore", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function createStore(): { root: string; store: PromptImageStore } {
    const root = mkdtempSync(path.join(tmpdir(), "prompt-images-"));
    roots.push(root);
    return { root, store: new PromptImageStore(root, logger) };
  }

  it("writes an image once under its agent, named by content", async () => {
    const { root, store } = createStore();
    const image = { data: Buffer.from("png bytes").toString("base64"), mimeType: "image/png" };

    const first = store.keep("agent-1", image);
    const second = store.keep("agent-1", image);

    await store.flush();

    expect(first).toBe(second);
    expect(path.dirname(first!)).toBe(path.join(root, "agent-1"));
    expect(path.basename(first!)).toMatch(/^[0-9a-f]{64}\.png$/);
    expect(readFileSync(first!, "utf8")).toBe("png bytes");
  });

  it("deletes an agent's images and ignores ids that are not plain names", async () => {
    const { root, store } = createStore();
    const kept = store.keep("agent-1", { data: "aW1hZ2U=", mimeType: "image/webp" });

    expect(store.keep("../escape", { data: "aW1hZ2U=", mimeType: "image/png" })).toBeNull();
    await store.deleteAgent("agent-1");

    expect(existsSync(kept!)).toBe(false);
    expect(existsSync(path.join(root, "agent-1"))).toBe(false);
  });
});
