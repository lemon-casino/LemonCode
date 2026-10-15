import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { acquireFileLock } from "@lcode/shared/node";

/** 安装与 prune 共用一个跨进程 gate；活锁不按时间回收，取得失败就让调用方报告占用。 */
export async function withPackageStoreLease<T>(
  storePath: string,
  action: () => Promise<T>,
  options: { shared?: boolean } = {},
): Promise<T> {
  const root = resolve(storePath);
  await mkdir(root, { recursive: true });
  const release = await acquireFileLock(join(root, ".lcode-package-operation"), [], 0, 0, options);
  try {
    return await action();
  } finally {
    await release();
  }
}
