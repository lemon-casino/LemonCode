import type { AppSettings } from "@lcode/shared";

type MemoryStorageSettings = Pick<AppSettings, "memoryStorageLocation" | "memoryStorageRevision">;

/** Only the original settings owner calls this, after rereading under its existing file lock. */
export function assertMemoryStorageTransition(
  current: MemoryStorageSettings,
  next: MemoryStorageSettings,
  patch: Partial<MemoryStorageSettings>,
): void {
  // 通用 patch 曾能绕过切换命令回退位置标记；位置变化和版本推进必须由同一锁内写入成对校验。
  const revision = current.memoryStorageRevision ?? 0;
  if ((next.memoryStorageLocation ?? "profile") !== (current.memoryStorageLocation ?? "profile")) {
    if (patch.memoryStorageRevision !== revision + 1)
      throw new Error("Memory storage location changes require the next revision.");
  } else if (
    Object.hasOwn(patch, "memoryStorageRevision") &&
    patch.memoryStorageRevision !== revision
  ) {
    throw new Error("Memory storage revision cannot change without a location change.");
  }
}
