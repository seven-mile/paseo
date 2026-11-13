import { useEffect } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useFetchQuery } from "@/data/query";
import { persistAttachmentFromBytes } from "./service";
import { retainAttachmentForGarbageCollection } from "./gc-retention";
import type { AttachmentMetadata } from "./types";
import { createPreviewAttachmentId } from "./utils";

export function splitHostPath(path: string): { directory: string; name: string } | null {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (index <= 0 || index === path.length - 1) return null;
  return { directory: path.slice(0, index), name: path.slice(index + 1) };
}

/**
 * An image the host kept from a sent message, copied into local attachment storage so it renders
 * like an image this client sent. Null until it loads, and when it can't be read.
 */
export function useKeptImage(input: {
  client: Pick<DaemonClient, "readFile"> | null | undefined;
  serverId: string | undefined;
  path: string | undefined;
}): AttachmentMetadata | null {
  const { client, serverId, path } = input;
  const target = path ? splitHostPath(path) : null;
  const query = useFetchQuery({
    queryKey: ["keptImage", serverId ?? "unknown-server", path ?? ""],
    enabled: Boolean(client && target),
    immutableWhen: () => true,
    dataShape: "value",
    // The host writes the file just after recording the row, so an early read can miss it.
    retry: 2,
    queryFn: async (): Promise<AttachmentMetadata> => {
      if (!client || !target || !path) throw new Error("Image unavailable");
      const file = await client.readFile(target.directory, target.name);
      if (file.kind !== "image") throw new Error("Image unavailable");
      return await persistAttachmentFromBytes({
        id: createPreviewAttachmentId({
          mimeType: file.mime,
          path,
          size: file.size,
          contentLength: file.bytes.byteLength,
          contentKey: `${serverId ?? "unknown-server"}:kept-image`,
        }),
        bytes: file.bytes,
        mimeType: file.mime,
        fileName: target.name,
      });
    },
  });
  const attachmentId = query.data?.id;
  useEffect(() => {
    if (!attachmentId) return undefined;
    return retainAttachmentForGarbageCollection(attachmentId);
  }, [attachmentId]);
  return query.data ?? null;
}
