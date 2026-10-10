import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, extname } from "node:path";
import { VIDEO_INSPECT_MAX_SUBTITLE_BYTES, VideoProcessorPortError } from "@lcode/contracts";
import { assertVideoNotCancelled } from "./execution.js";

export interface VideoSidecar {
  path: string;
  text: string;
  digest: string;
}
const identityMatches = (left: Stats, right: Stats) =>
  right.isFile() && left.dev === right.dev && left.ino === right.ino;

export async function readVideoSidecar(
  path: string,
  signal?: AbortSignal,
): Promise<VideoSidecar | undefined> {
  assertVideoNotCancelled(signal);
  const stem = path.slice(0, path.length - extname(path).length);
  for (const extension of [".srt", ".vtt"]) {
    const candidate = stem + extension;
    let observed: Stats;
    try {
      observed = await lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (!observed.isFile() || observed.isSymbolicLink() || dirname(candidate) !== dirname(path))
      continue;
    if (observed.size > VIDEO_INSPECT_MAX_SUBTITLE_BYTES)
      throw new VideoProcessorPortError("too_large", "Sidecar subtitles exceed the 64 KiB limit.");
    const handle = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      // lstat 与 open 有异步窗口；读正文前核对句柄身份，防止被替换成越权限 symlink。
      const opened = await handle.stat(),
        current = await lstat(candidate);
      if (
        !identityMatches(observed, opened) ||
        current.isSymbolicLink() ||
        !identityMatches(opened, current)
      )
        throw new VideoProcessorPortError("stale", "Subtitle source changed before reading.");
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of handle.createReadStream({
        autoClose: false,
        ...(signal ? { signal } : {}),
      })) {
        assertVideoNotCancelled(signal);
        bytes += chunk.byteLength;
        if (bytes > VIDEO_INSPECT_MAX_SUBTITLE_BYTES)
          throw new VideoProcessorPortError(
            "too_large",
            "Sidecar subtitles exceed the 64 KiB limit.",
          );
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks, bytes);
      return {
        path: candidate,
        text: data.toString("utf8"),
        digest: createHash("sha256").update(data).digest("hex"),
      };
    } finally {
      await handle.close();
    }
  }
  return undefined;
}
