import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { WorkspaceHookTrustRecord, WorkspaceHookTrustStoreFile } from "@lcode/contracts";
import {
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_STALE_LOCK_MS,
  defaultWriteLockOwnerMetadata,
  probeProcessStartTimeDefault,
  withWorkspaceHookTrustLock,
} from "./workspace-hook-trust-lock.js";
import {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@lcode/contracts";

const DEFAULT_RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const SECURITY_DIRECTORY = "security";
const TRUST_STORE_FILE = "workspace-hook-trust-v1.json";

export type WorkspaceHookTrustStoreLoadResult =
  | { status: "missing"; records: [] }
  | { status: "ok"; records: WorkspaceHookTrustRecord[] }
  | { status: "corrupt"; records: []; recoveredCorruptPath: string };

export interface FileWorkspaceHookTrustStoreOptions {
  filePath: string;
  now?: () => number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  beforeRename?: () => void | Promise<void>;
  renameFile?: typeof rename;
  renameRetryDelaysMs?: readonly number[];
  /** 测试注入：查询 pid 当前实例启动时间；默认按平台实现（/proc / ps / powershell）。 */
  probeProcessStartTime?: (pid: number) => Promise<number | null>;
  /** 测试注入：写锁 owner metadata；默认 FileHandle.writeFile。 */
  writeLockOwnerMetadata?: (handle: FileHandle, content: string) => Promise<void>;
}

export interface WorkspaceHookTrustStoreCompactOptions {
  current: Array<{ workspaceIdentity: string; hookDeclarationDigest: string }>;
  maxAgeMs: number;
  maxRecords: number;
  now?: number;
}

export interface WorkspaceHookTrustStoreRevokeOptions {
  workspaceIdentity: string;
  hookDeclarationDigests?: readonly string[];
}

export interface WorkspaceHookTrustStorePathOptions {
  homeDir?: string;
  userConfigPath?: string;
}

export async function resolveWorkspaceHookTrustStorePath(
  options: WorkspaceHookTrustStorePathOptions = {},
): Promise<string> {
  const home = resolve(options.homeDir ?? homedir());
  const userConfigPath = resolve(
    options.userConfigPath ?? join(home, ".lcode", "cli", "config.json"),
  );
  const config = await readUserConfig(userConfigPath);
  const storage = isRecord(config.storage) ? config.storage : {};
  const configured = typeof storage.dir === "string" ? storage.dir.trim() : "";
  const storageRoot = configured ? resolveTrustedUserPath(configured, home) : join(home, ".lcode");
  return join(storageRoot, SECURITY_DIRECTORY, TRUST_STORE_FILE);
}

export async function createDefaultFileWorkspaceHookTrustStore(
  options: WorkspaceHookTrustStorePathOptions &
    Omit<FileWorkspaceHookTrustStoreOptions, "filePath"> = {},
): Promise<FileWorkspaceHookTrustStore> {
  return createFileWorkspaceHookTrustStore({
    ...options,
    filePath: await resolveWorkspaceHookTrustStorePath(options),
  });
}

export function createFileWorkspaceHookTrustStore(
  options: FileWorkspaceHookTrustStoreOptions,
): FileWorkspaceHookTrustStore {
  return new FileWorkspaceHookTrustStore(options);
}

export class FileWorkspaceHookTrustStore {
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly now: () => number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly beforeRename?: () => void | Promise<void>;
  private readonly renameFile: typeof rename;
  private readonly renameRetryDelaysMs: readonly number[];
  private readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  private readonly writeLockOwnerMetadata: (handle: FileHandle, content: string) => Promise<void>;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: FileWorkspaceHookTrustStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.lockPath = `${this.filePath}.lock`;
    this.now = options.now ?? Date.now;
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.beforeRename = options.beforeRename;
    this.renameFile = options.renameFile ?? rename;
    this.renameRetryDelaysMs = options.renameRetryDelaysMs ?? DEFAULT_RENAME_RETRY_DELAYS_MS;
    this.probeProcessStartTime = options.probeProcessStartTime ?? probeProcessStartTimeDefault;
    this.writeLockOwnerMetadata = options.writeLockOwnerMetadata ?? defaultWriteLockOwnerMetadata;
  }

  load(): Promise<WorkspaceHookTrustStoreLoadResult> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(() => this.readCurrent(true));
    });
  }

  grant(records: readonly WorkspaceHookTrustRecord[]): Promise<WorkspaceHookTrustStoreFile> {
    const validated = records.map((record) => workspaceHookTrustRecordSchema.parse(record));
    return this.mutate((current) => {
      const next = new Map(current.records.map((record) => [trustKey(record), record] as const));
      for (const record of validated) next.set(trustKey(record), record);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...next.values()],
      };
    });
  }

  revoke(options: WorkspaceHookTrustStoreRevokeOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (options.hookDeclarationDigests?.length === 0) {
      // 空数组会生成空 Set，filter 因而保留全部记录并静默成功，调用方无法
      // 区分“撤销全部”的 undefined 与“没有目标”的无效请求。三态固定为：undefined
      // 撤销 workspace 全部、非空数组精确撤销、空数组在任何 IO 前拒绝。
      return Promise.reject(new Error("hookDeclarationDigests must be undefined or non-empty"));
    }
    const selected = options.hookDeclarationDigests
      ? new Set(options.hookDeclarationDigests)
      : undefined;
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.filter(
        (record) =>
          record.workspaceIdentity !== options.workspaceIdentity ||
          (selected !== undefined && !selected.has(record.hookDeclarationDigest)),
      ),
    }));
  }

  touch(input: {
    workspaceIdentity: string;
    hookDeclarationDigests: readonly string[];
    usedAt?: string;
  }): Promise<WorkspaceHookTrustStoreFile> {
    const selected = new Set(input.hookDeclarationDigests);
    const usedAt = input.usedAt ?? new Date(this.now()).toISOString();
    return this.mutate((current) => ({
      schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
      records: current.records.map((record) =>
        record.workspaceIdentity === input.workspaceIdentity &&
        selected.has(record.hookDeclarationDigest)
          ? { ...record, lastUsedAt: usedAt }
          : record,
      ),
    }));
  }

  compact(options: WorkspaceHookTrustStoreCompactOptions): Promise<WorkspaceHookTrustStoreFile> {
    if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0) {
      throw new Error("maxAgeMs must be a nonnegative finite number");
    }
    if (!Number.isInteger(options.maxRecords) || options.maxRecords < 1) {
      throw new Error("maxRecords must be a positive integer");
    }
    const now = options.now ?? this.now();
    const current = new Set(
      options.current.map((entry) =>
        trustKey({
          workspaceIdentity: entry.workspaceIdentity,
          hookDeclarationDigest: entry.hookDeclarationDigest,
        }),
      ),
    );
    return this.mutate((store) => {
      const retained = store.records.filter((record) => {
        if (current.has(trustKey(record))) return true;
        const timestamp = Date.parse(record.lastUsedAt ?? record.grantedAt);
        return Number.isFinite(timestamp) && now - timestamp <= options.maxAgeMs;
      });
      const currentRecords = retained.filter((record) => current.has(trustKey(record)));
      const nonCurrent = retained
        .filter((record) => !current.has(trustKey(record)))
        .sort((left, right) => recordTimestamp(right) - recordTimestamp(left));
      const available = Math.max(0, options.maxRecords - currentRecords.length);
      return {
        schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
        records: [...currentRecords, ...nonCurrent.slice(0, available)],
      };
    });
  }

  private mutate(
    update: (current: WorkspaceHookTrustStoreFile) => WorkspaceHookTrustStoreFile,
  ): Promise<WorkspaceHookTrustStoreFile> {
    return this.enqueue(async () => {
      await this.ensureSecurityDirectory();
      return this.withLock(async () => {
        const loaded = await this.readCurrent(true);
        const current: WorkspaceHookTrustStoreFile = {
          schemaVersion: WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
          records: loaded.status === "ok" ? loaded.records : [],
        };
        const next = workspaceHookTrustStoreFileSchema.parse(update(current));
        await this.atomicWrite(next);
        return next;
      });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    return withWorkspaceHookTrustLock(
      {
        lockPath: this.lockPath,
        lockTimeoutMs: this.lockTimeoutMs,
        staleLockMs: this.staleLockMs,
        probeProcessStartTime: this.probeProcessStartTime,
        writeLockOwnerMetadata: this.writeLockOwnerMetadata,
      },
      operation,
    );
  }

  private async ensureSecurityDirectory(): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }

  private async readCurrent(recoverCorrupt: boolean): Promise<WorkspaceHookTrustStoreLoadResult> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { status: "missing", records: [] };
      throw error;
    }

    try {
      const parsed = workspaceHookTrustStoreFileSchema.parse(JSON.parse(content) as unknown);
      // chmod 是权限加固副作用，不是 load 的核心职责。只读目录/异常所有权下
      // chmod 会抛 EPERM/EROFS，若任其冒泡，整个 load 都会失败——比一次加固失败
      // 应有的后果重得多。加固失败只降级为忽略：读出来的记录仍然有效，
      // 后续 mutate 的 atomicWrite 会再次尝试。
      await chmod(this.filePath, 0o600).catch(() => undefined);
      return { status: "ok", records: parsed.records };
    } catch (error) {
      if (!recoverCorrupt) throw error;
      const recoveredCorruptPath = `${this.filePath}.corrupt-${this.now()}`;
      // 损坏文件改名失败（只读目录等）若让错误冒泡，会绕过"返回 corrupt 状态"
      // 的设计路径——调用方看到的是意外异常而非 fail-closed 的 corrupt 状态。
      // 改名失败仍按 corrupt 返回：corrupt 语义即全部 Hook 不受信（fail-closed），
      // 原文件残留在原地不会让任何记录被当作可信。
      try {
        await rename(this.filePath, recoveredCorruptPath);
        await chmod(recoveredCorruptPath, 0o600).catch(() => undefined);
      } catch {
        // 改名失败：仍返回 corrupt 状态，原损坏文件留在原地（下次 load 仍判 corrupt）。
      }
      return { status: "corrupt", records: [], recoveredCorruptPath };
    }
  }

  private async atomicWrite(store: WorkspaceHookTrustStoreFile): Promise<void> {
    const directory = dirname(this.filePath);
    const tempPath = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
    );
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await this.beforeRename?.();
      await renameWithRetry(this.renameFile, tempPath, this.filePath, this.renameRetryDelaysMs);
      await chmod(this.filePath, 0o600);
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}

async function renameWithRetry(
  renameFile: typeof rename,
  tempPath: string,
  filePath: string,
  retryDelaysMs: readonly number[],
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await renameFile(tempPath, filePath);
      return;
    } catch (error) {
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined || !isRetryableRenameError(error)) throw error;
      // Windows 杀软/索引器可能短暂占用目标文件，单次 rename 会让已完成
      // fsync 的 Trust mutation 误报失败。仅对已知短暂占用错误做有界异步重试。
      await sleep(delayMs);
    }
  }
}

function isRetryableRenameError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function readUserConfig(path: string): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    throw new Error(`Unable to read trusted user config for Workspace Hook Trust store: ${path}`, {
      cause: error,
    });
  }
}

function resolveTrustedUserPath(path: string, home: string): string {
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  // 安全原因：user config 中的相对 storage.dir 绑定用户目录，不能随 workspace cwd 漂移。
  return resolve(home, path);
}

function trustKey(record: { workspaceIdentity: string; hookDeclarationDigest: string }): string {
  return `${record.workspaceIdentity}\u0000${record.hookDeclarationDigest}`;
}

function recordTimestamp(record: WorkspaceHookTrustRecord): number {
  return Date.parse(record.lastUsedAt ?? record.grantedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
