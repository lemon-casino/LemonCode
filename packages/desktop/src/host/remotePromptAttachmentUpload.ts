import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { IRemoteBackend, RemoteUploadOptions } from "@lcode/server/remote";
import { quotePosixPathArg } from "@lcode/server/remote/posixShell.js";

interface UploadEntry {
  localPath: string;
  remotePath: string;
  directory: boolean;
  bytes: number;
  executable: boolean;
}

/** Host owns tree materialization; backends keep their single-file streaming contract. */
export async function uploadRemotePromptAttachment(
  backend: Pick<IRemoteBackend, "upload">,
  runCommand: (command: string) => Promise<void>,
  localPath: string,
  remotePath: string,
  options?: RemoteUploadOptions,
): Promise<{ directory: boolean; bytes: number }> {
  const entries: UploadEntry[] = [];
  const pending = [{ localPath, remotePath }];
  let totalBytes = 0;
  // 原实现把目录直接交给 createReadStream，必然 EISDIR。先异步枚举节点，
  // 再逐文件复用 backend.upload；不跟随链接，避免目录环和上传范围越界。
  while (pending.length > 0) {
    options?.signal?.throwIfAborted();
    const current = pending.pop()!;
    const info = await lstat(current.localPath);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
      throw new Error(
        "Unsupported attachment entry: symbolic links and special files cannot be uploaded",
      );
    }
    const directory = info.isDirectory();
    entries.push({
      ...current,
      directory,
      bytes: directory ? 0 : info.size,
      executable: (info.mode & 0o100) !== 0,
    });
    if (directory) {
      for (const child of await readdir(current.localPath)) {
        pending.push({
          localPath: join(current.localPath, child),
          remotePath: `${current.remotePath}/${child}`,
        });
      }
    } else {
      totalBytes += info.size;
    }
  }

  let uploadedBytes = 0;
  options?.onProgress?.({ uploadedBytes, totalBytes });
  for (const entry of entries) {
    options?.signal?.throwIfAborted();
    const quotedPath = quotePosixPathArg(entry.remotePath);
    if (entry.directory) {
      // umask 在 mkdir 当场生效，目录中的附件内容不会短暂暴露给其他用户。
      await runCommand(`umask 077 && mkdir -p ${quotedPath} && command chmod 700 ${quotedPath}`);
    } else {
      let fileProgress = 0;
      await backend.upload(entry.localPath, entry.remotePath, {
        signal: options?.signal,
        onProgress(progress) {
          fileProgress = Math.max(fileProgress, Math.min(entry.bytes, progress.uploadedBytes));
          options?.onProgress?.({ uploadedBytes: uploadedBytes + fileProgress, totalBytes });
        },
      });
      options?.signal?.throwIfAborted();
      await runCommand(`command chmod ${entry.executable ? "700" : "600"} ${quotedPath}`);
      uploadedBytes += entry.bytes;
      options?.onProgress?.({ uploadedBytes, totalBytes });
    }
  }
  options?.signal?.throwIfAborted();
  return { directory: entries[0]!.directory, bytes: totalBytes };
}
