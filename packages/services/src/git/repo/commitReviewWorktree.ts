import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

export async function readCommitReviewWorktree(
  cwd: string,
  paths: readonly string[],
  maxBytes: number,
) {
  const contents: Array<[string, number | null, string?]> = [];
  // 中文依据：总文件数不限，顺序读取避免大量文件同时 open 耗尽系统句柄。
  for (const path of paths) {
    try {
      const info = await lstat(join(cwd, path));
      if (!info.isFile() || info.size > maxBytes)
        throw new Error("提交审核仅支持有界普通文本文件。");
      const hash = createHash("sha256")
        .update(await readFile(join(cwd, path)))
        .digest("hex");
      contents.push([path, info.mode & 0o111, hash]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") contents.push([path, null]);
      else throw error;
    }
  }
  return contents;
}
