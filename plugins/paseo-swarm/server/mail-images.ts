import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mailboxMessageStatus, type MailboxMessage, type MailImage } from "../shared/models";
import { getDataDirectory } from "./state";

// A file written for a send that has not committed its message yet is not referenced by any row,
// so the sweep leaves files this young alone.
export const MAIL_IMAGE_SWEEP_AGE_MS = 10 * 60_000;

function directory(): string {
  return join(getDataDirectory(), "mail-images");
}

const extensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
};

export interface StoredMailImage extends MailImage {
  size: number;
}

// Files are named by the hash of their bytes, so the recipient and its Cc copies share one file.
// The extension lets an agent's file tools open a Cc copy's image by its path. Files from before
// it have none and still read.
export function storeMailImages(
  images: readonly { data: string; mimeType: string }[],
): StoredMailImage[] {
  if (images.length === 0) return [];
  mkdirSync(directory(), { recursive: true });
  return images.map(({ data, mimeType }) => {
    const bytes = Buffer.from(data, "base64");
    const hash = createHash("sha256").update(bytes).digest("hex");
    const file = `${hash}${extensions[mimeType] ?? ""}`;
    writeFileSync(join(directory(), file), bytes);
    return { file, mimeType, size: bytes.length };
  });
}

export function mailImagePath(file: string): string {
  return join(directory(), file);
}

export function readMailImages(images: readonly MailImage[]): { data: string; mimeType: string }[] {
  return images.map(({ file, mimeType }) => ({
    data: readFileSync(join(directory(), file)).toString("base64"),
    mimeType,
  }));
}

// Deletes the files no message needs: a queued message sends its images, and a Cc copy that names
// an image by path keeps it while the copy is kept. Delivered images are in the agent's own
// history, and failed mail is never resent.
export function sweepMailImages(messages: readonly MailboxMessage[], now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(directory());
  } catch {
    return;
  }
  const needed = new Set(
    messages.flatMap((message) => [
      ...(mailboxMessageStatus(message) === "queued"
        ? (message.images?.map((image) => image.file) ?? [])
        : []),
      ...(message.files ?? []),
    ]),
  );
  for (const name of names) {
    if (needed.has(name)) continue;
    const path = join(directory(), name);
    try {
      if (now - statSync(path).mtimeMs < MAIL_IMAGE_SWEEP_AGE_MS) continue;
      rmSync(path, { force: true });
    } catch {
      // Gone already.
    }
  }
}
