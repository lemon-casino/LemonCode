import { DataRootLock } from "./lock.js";
import type { ServerLayout } from "./paths.js";
import { readPersistedStatusDetailed } from "./statusSnapshot.js";
import { describeLockInspection } from "./uninstallGuard.js";

export async function waitForServerStopped(
  layout: ServerLayout,
  minUpdatedAt = 0,
  requireFreshSnapshot = false,
): Promise<void> {
  const deadline = Date.now() + 6_000;
  while (Date.now() < deadline) {
    const persisted = await readPersistedStatusDetailed(layout);
    if (persisted.state === "invalid" || persisted.state === "unreadable") {
      throw new Error("Cannot verify Server shutdown status");
    }
    const lockInspection = await new DataRootLock(layout.lockFile).inspect();
    if (lockInspection.state === "invalid" || lockInspection.state === "unreadable") {
      throw new Error(`Cannot verify Server shutdown (${describeLockInspection(lockInspection)})`);
    }
    const lockReleased = lockInspection.state === "missing" || lockInspection.state === "stale";
    const stopped =
      persisted.status?.state === "stopped" || persisted.status?.state === "uninstalled";
    const freshSnapshot = persisted.status !== null && persisted.status.updatedAt > minUpdatedAt;
    // stopped 落盘早于 lock.release，陈旧的 stopped 快照不能作为立即注册新服务的依据。
    // 迁移必须同时确认新快照和锁已释放；只有离线卸载且没有任何快照时才允许仅凭缺锁继续。
    if (
      lockReleased &&
      ((stopped && (!requireFreshSnapshot || freshSnapshot)) ||
        (!requireFreshSnapshot && persisted.state === "missing"))
    )
      return;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for Server shutdown (${layout.statusFile})`);
}
