import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";

const EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
};

const AGENT_ID = /^[A-Za-z0-9_-]+$/;

export interface PromptImage {
  data: string;
  mimeType: string;
}

/**
 * Keeps the images a person sends so any client can show them again: another device, a reload,
 * or mail from a Swarm seat. Files live under one directory per agent, named by content, and go
 * when the agent's state is deleted.
 */
export class PromptImageStore {
  private readonly logger: Logger;
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly root: string,
    logger: Logger,
  ) {
    this.logger = logger.child({ component: "prompt-image-store" });
  }

  /**
   * Returns where the image will be and writes it in the background. The path depends only on
   * the agent and the content, so the timeline row can name it before the write finishes.
   * Returns null for an agent id that isn't a plain name.
   */
  keep(agentId: string, image: PromptImage): string | null {
    if (!AGENT_ID.test(agentId)) return null;
    const directory = path.join(this.root, agentId);
    const digest = createHash("sha256").update(image.data).digest("hex");
    const file = path.join(directory, `${digest}${EXTENSIONS[image.mimeType] ?? ".img"}`);
    const write = this.write(directory, file, image.data);
    this.pending.add(write);
    void write.finally(() => this.pending.delete(write));
    return file;
  }

  /** Resolves once every image passed to `keep` so far is on disk or has failed. */
  async flush(): Promise<void> {
    await Promise.all(this.pending);
  }

  private async write(directory: string, file: string, data: string): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(file, Buffer.from(data, "base64"), { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      this.logger.warn({ err: error, file }, "Failed to keep prompt image");
    }
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (!AGENT_ID.test(agentId)) return;
    await this.flush();
    await rm(path.join(this.root, agentId), { recursive: true, force: true });
  }
}
