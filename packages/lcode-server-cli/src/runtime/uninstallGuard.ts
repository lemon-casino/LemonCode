import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DataRootLock, type DataRootLockInspection } from "./lock.js";
import type { ServerLayout } from "./paths.js";

export async function acquireUninstallLock(layout: ServerLayout): Promise<DataRootLock> {
  const lock = new DataRootLock(layout.lockFile);
  const inspection = await lock.inspect();
  if (inspection.state === "active") {
    throw new Error(`Cannot uninstall while Server lock is held by pid ${inspection.pid}`);
  }
  if (inspection.state === "invalid" || inspection.state === "unreadable") {
    throw new Error(`Cannot acquire uninstall lock (${describeLockInspection(inspection)})`);
  }
  await lock.acquire();
  return lock;
}

export async function removeRunContentsExceptLock(layout: ServerLayout): Promise<void> {
  const entries = await readdir(layout.runDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === "server.lock") continue;
    await rm(join(layout.runDir, entry.name), { recursive: true, force: true });
  }
}

export function describeLockInspection(inspection: DataRootLockInspection): string {
  if (inspection.state === "active") return `active pid ${inspection.pid}`;
  if (inspection.state === "stale") return `stale pid ${inspection.pid}`;
  if (inspection.state === "unreadable") return "lock file is unreadable";
  return `lock state is ${inspection.state}`;
}
