import { lstat, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** 调用者先完成精确会话事务；只接受会话私有目录，不扫描共享缓存或多会话日志。 */
export async function deleteSessionRuntimeArtifacts(
  sessionIds: readonly string[],
  cliRoot: string,
): Promise<void> {
  const ids = [...new Set(sessionIds)];
  if (ids.some((id) => !/^[a-zA-Z0-9_-]{1,80}$/u.test(id)))
    throw new Error("Invalid session ID for private artifact deletion");
  const root = resolve(cliRoot);
  async function inspect(path: string) {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const canonical = await realpath(path);
    const same =
      process.platform === "win32"
        ? canonical.toLowerCase() === path.toLowerCase()
        : canonical === path;
    if (!stat.isDirectory() || stat.isSymbolicLink() || !same)
      throw new Error("Session private directory has been redirected or is a symlink");
    return stat;
  }
  if (!(await inspect(root))) return;
  const targets: Array<{ path: string; dev: number; ino: number }> = [];
  // 先预检所有固定根和目标，防止较晚发现重定向时前面的会话产物已经被删除。
  for (const kind of ["agents", "artifacts", "exec"] as const) {
    const base = join(root, kind);
    if (!(await inspect(base))) continue;
    for (const id of ids) {
      const path = join(base, id);
      const stat = await inspect(path);
      if (stat) targets.push({ path, dev: stat.dev, ino: stat.ino });
    }
  }
  for (const target of targets) {
    const current = await inspect(target.path);
    if (!current) continue;
    if (current.dev !== target.dev || current.ino !== target.ino)
      throw new Error("Session private directory changed during deletion");
    await rm(target.path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (await inspect(target.path))
      throw new Error("Session private directory remains after deletion");
  }
}
