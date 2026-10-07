import type { Stats } from "node:fs";
import { lstat, mkdir, opendir, realpath, rmdir, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import type { RuntimeEnvironmentResourceSummary } from "@lcode/shared";
import { normalizeResourceScanBudget, type ResourceScanBudget } from "../app/resourceControl.js";
import { isPathWithin } from "./backendPlatform.js";

export class ResourceScanFailure extends Error {
  constructor(readonly status: "partial" | "unavailable", message: string) { super(message); }
}
export class ResourceBudget {
  readonly limits: ResourceScanBudget;
  readonly started = performance.now();
  entries = 0;
  constructor(limits: ResourceScanBudget) { this.limits = normalizeResourceScanBudget(limits); }
  check(): void {
    if (performance.now() - this.started >= this.limits.maxDurationMs) {
      throw new ResourceScanFailure("partial", "Resource scan time budget exhausted");
    }
  }
  take(): void {
    this.check();
    if (this.entries >= this.limits.maxEntries) throw new ResourceScanFailure("partial", "Resource scan entry budget exhausted");
    this.entries++;
  }
}
export function resourceFailure(error: unknown): ResourceScanFailure {
  return error instanceof ResourceScanFailure ? error : new ResourceScanFailure("unavailable", "Managed resource missing, corrupt, inaccessible or outside containment");
}
export function sameResourcePath(a: string, b: string): boolean {
  return process.platform === "win32" ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
}

/** 不跟随软链/目录联接；每次 IO 前重验祖先和 realpath，而不是只做字符串前缀判断。 */
export async function inspectResourcePath(root: string, path: string, optional = false): Promise<Stats | undefined> {
  if (!isPathWithin(root, path)) throw new ResourceScanFailure("unavailable", "Managed resource containment failed");
  const pieces = relative(root, path).split(sep).filter(Boolean);
  let current = resolve(root);
  let canonicalRoot: string | undefined;
  let entry: Stats | undefined;
  for (let index = 0; index <= pieces.length; index++) {
    if (index) current = join(current, pieces[index - 1]!);
    try { entry = await lstat(current); }
    catch (error) {
      if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    if (entry.isSymbolicLink() || (index < pieces.length && !entry.isDirectory())) {
      throw new ResourceScanFailure("unavailable", "Managed resource symlink or invalid ancestor");
    }
    const canonical = await realpath(current);
    canonicalRoot ??= canonical;
    if (!sameResourcePath(canonical, join(canonicalRoot, ...pieces.slice(0, index)))) {
      throw new ResourceScanFailure("unavailable", "Managed resource realpath containment failed");
    }
  }
  return entry;
}

export async function ensureResourceDirectory(root: string, path: string): Promise<void> {
  if (!isPathWithin(root, path)) throw new ResourceScanFailure("unavailable", "Managed resource containment failed");
  if (!(await inspectResourcePath(root, root, true))) {
    await mkdir(root, { recursive: true });
    await inspectResourcePath(root, root);
  }
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!(await inspectResourcePath(root, current, true))) {
      await inspectResourcePath(root, dirname(current));
      try { await mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    }
    if (!(await inspectResourcePath(root, current))?.isDirectory()) throw new ResourceScanFailure("unavailable", "Managed resource is not a directory");
  }
}

export interface ResourceTreeEntry { path: string; directory: boolean; size: number; dev: number; ino: number; mtimeMs: number }
export async function walkResources(root: string, path: string, budget: ResourceBudget, entries: ResourceTreeEntry[]): Promise<void> {
  budget.take();
  const stat = await inspectResourcePath(root, path);
  budget.check();
  if (!stat || (!stat.isFile() && !stat.isDirectory())) throw new ResourceScanFailure("unavailable", "Unsupported managed resource entry");
  entries.push({ path, directory: stat.isDirectory(), size: stat.size, dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs });
  if (!stat.isDirectory()) return;
  const dir = await opendir(path, { bufferSize: 1 });
  try {
    while (true) {
      budget.check();
      const child = await dir.read();
      budget.check();
      if (!child) break;
      await walkResources(root, join(path, child.name), budget, entries);
    }
  } finally { await dir.close(); }
}

export function summarizeResources(budget: ResourceBudget, entries: ResourceTreeEntry[], failure?: ResourceScanFailure): RuntimeEnvironmentResourceSummary {
  const files = entries.filter((entry) => !entry.directory);
  return {
    status: failure?.status ?? "complete",
    scannedAt: new Date().toISOString(),
    scanBudget: budget.limits,
    ...(failure?.status === "unavailable" ? {} : { bytes: files.reduce((total, entry) => total + entry.size, 0), fileCount: files.length }),
    ...(failure ? { reason: failure.message } : {}),
  };
}

/** 先完整验证，后逐项 unlink/rmdir；不使用 recursive rm 跟进后来出现的未知内容。 */
export async function removeResourceTree(root: string, entries: ResourceTreeEntry[], budget: ResourceBudget): Promise<void> {
  for (const entry of [...entries].reverse()) {
    budget.take();
    const stat = await inspectResourcePath(root, entry.path);
    budget.check();
    if (!stat || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.isDirectory() !== entry.directory ||
      (!entry.directory && (stat.size !== entry.size || stat.mtimeMs !== entry.mtimeMs))) {
      throw new ResourceScanFailure("unavailable", "Managed resource changed before deletion");
    }
    if (entry.directory) await rmdir(entry.path); else await unlink(entry.path);
  }
}
