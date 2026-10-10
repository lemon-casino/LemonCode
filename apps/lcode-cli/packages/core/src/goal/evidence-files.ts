import { createHash } from "node:crypto";
import { resolve, relative, isAbsolute } from "node:path";
import { lcodeWorkspaceRefSchema } from "@lcode/shared";
import type { GoalEvidenceOwner } from "./evidence-types.js";

const FILE_BYTES = 4 * 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;

export async function bindingHash(owner: GoalEvidenceOwner): Promise<string | null> {
  const session = await owner.store?.getSession?.(owner.sessionId);
  if (!session) return null;
  const entries =
    (await owner.store?.sessionEntries?.({
      sessionID: owner.sessionId,
      type: "runtime/worktree_binding",
      limit: 17,
    })) ?? [];
  const bindings = entries.filter((entry) => entry.type === "runtime/worktree_binding");
  if (bindings.length > 16) return null;
  const normalized = (path: string) =>
    process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
  const latestBinding = bindings.at(-1);
  if (latestBinding) {
    const parsed = lcodeWorkspaceRefSchema.safeParse(latestBinding.data);
    if (
      !parsed.success ||
      normalized(parsed.data.workspacePath) !== normalized(owner.workspacePath) ||
      (parsed.data.workspaceIdentity?.trim() || parsed.data.workspacePath) !== owner.workspaceKey
    )
      return null;
  } else if (
    normalized(session.directory) !== normalized(owner.workspacePath) ||
    (session.workspaceID?.trim() && session.workspaceID.trim() !== owner.workspaceKey)
  )
    return null;
  return createHash("sha256")
    .update(
      JSON.stringify([
        owner.workspaceKey,
        owner.workspacePath,
        session?.revert?.branchGeneration ?? 0,
        bindings.map((entry) => [entry.id, entry.data]),
      ]),
    )
    .digest("hex");
}
/** Digest only the explicit acceptance coverage; missing or unsupported coverage stays unknown. */
export async function digestGoalFiles(
  owner: GoalEvidenceOwner,
  paths: readonly string[],
): Promise<string | null> {
  if (!owner.fileSystem) return null;
  const hash = createHash("sha256").update("goal-file-digest:v2\0");
  let bytes = 0;
  try {
    for (const path of [...new Set(paths)].sort()) {
      const absolute = resolve(owner.workspacePath, path);
      const relativePath = relative(owner.workspacePath, absolute);
      if (
        isAbsolute(relativePath) ||
        relativePath === ".." ||
        relativePath.startsWith(`..\\`) ||
        relativePath.startsWith("../")
      )
        return null;
      // 逐级 stat 拒绝 symlink，避免 workspace 内路径穿透到另一个身份的文件。
      let current = owner.workspacePath;
      for (const part of ["", ...relativePath.split(/[\\/]/u)]) {
        current = resolve(current, part);
        const node = await owner.fileSystem.stat({ path: current, followSymlinks: false });
        if (node.kind === "symlink" || node.symlinkChecked !== true) return null;
      }
      if ((await owner.fileSystem.stat({ path: absolute })).kind !== "file") return null;
      const result = await owner.fileSystem.readBinaryFile({
        path: absolute,
        maxBytes: FILE_BYTES,
      });
      current = owner.workspacePath;
      for (const part of ["", ...relativePath.split(/[\\/]/u)]) {
        current = resolve(current, part);
        const node = await owner.fileSystem.stat({ path: current, followSymlinks: false });
        if (node.kind === "symlink" || node.symlinkChecked !== true) return null;
      }
      bytes += result.bytesRead;
      if (
        bytes > TOTAL_BYTES ||
        result.bytesRead > FILE_BYTES ||
        result.bytesRead !== result.sizeBytes ||
        result.bytesRead !== result.content.byteLength
      )
        return null;
      // 二进制正文可含 NUL，直接拼接分隔符会让不同文件内容产生相同输入流；逐文件固定内容 hash 消除边界歧义。
      hash
        .update(
          JSON.stringify([
            path,
            result.bytesRead,
            createHash("sha256").update(result.content).digest("hex"),
          ]),
        )
        .update("\n");
    }
    return hash.digest("hex");
  } catch {
    return null;
  }
}

