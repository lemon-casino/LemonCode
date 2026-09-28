import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_LOCK_AGE_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const SEED_LOCK_TIMEOUT_ERROR_CODE = "LCODE_PLUGIN_SEED_LOCK_TIMEOUT";

interface OfficialPluginSeedLockOptions {
  retryDelayMs?: number;
  staleLockAgeMs?: number;
  timeoutMs?: number;
}

export function withOfficialPluginSeedLock<T>(
  targetRoot: string,
  action: () => T,
  options: OfficialPluginSeedLockOptions = {},
): T {
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleLockAgeMs = options.staleLockAgeMs ?? DEFAULT_STALE_LOCK_AGE_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lockRoot = `${targetRoot}.seed-lock`;
  const startedAt = Date.now();

  mkdirSync(dirname(lockRoot), { recursive: true });
  while (true) {
    try {
      mkdirSync(lockRoot);
      break;
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      tryTakeOverStaleLock(lockRoot, staleLockAgeMs);
      if (Date.now() - startedAt >= timeoutMs) {
        throw Object.assign(
          new Error(`[official-plugin-seed-lock] timed out waiting for ${lockRoot}`),
          { code: SEED_LOCK_TIMEOUT_ERROR_CODE },
        );
      }
      sleepSync(retryDelayMs);
    }
  }

  try {
    writeFileSync(
      join(lockRoot, "owner.json"),
      JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
    );
    return action();
  } finally {
    removeLockDirectory(lockRoot);
  }
}

/** 稳定错误码判定（项目规范：不靠错误文本分流），供调用方把等锁超时按降级处理。 */
export function isOfficialPluginSeedLockTimeoutError(
  error: unknown,
): error is NodeJS.ErrnoException {
  return errorCode(error) === SEED_LOCK_TIMEOUT_ERROR_CODE;
}

function tryTakeOverStaleLock(lockRoot: string, staleLockAgeMs: number): void {
  let ageMs: number;
  try {
    ageMs = Date.now() - statSync(lockRoot).mtimeMs;
  } catch (error) {
    if (isNotFoundError(error)) return;
    throw error;
  }

  const ownerPid = readLockOwnerPid(lockRoot);
  if (ownerPid !== undefined && isProcessAlive(ownerPid)) return;
  if (ownerPid === undefined && ageMs < staleLockAgeMs) return;

  const staleRoot = `${lockRoot}.stale-${process.pid}-${Date.now()}`;
  try {
    // 直接删除 stale lock 存在 TOCTOU，可能误删另一进程刚创建的新锁。
    // 先原子改名取得旧锁所有权，只清理自己成功改名的目录。
    renameSync(lockRoot, staleRoot);
  } catch (error) {
    if (isTransientLockRace(error)) return;
    throw error;
  }
  removeLockDirectory(staleRoot);
}

function readLockOwnerPid(lockRoot: string): number | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(lockRoot, "owner.json"), "utf8")) as {
      pid?: unknown;
    };
    return typeof owner.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0
      ? owner.pid
      : undefined;
  } catch (error) {
    if (isNotFoundError(error) || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows/Unix 都可能因权限返回 EPERM；这代表进程存在，只是不可探测。
    return errorCode(error) === "EPERM";
  }
}

function removeLockDirectory(path: string): void {
  rmSync(path, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: DEFAULT_RETRY_DELAY_MS,
  });
}

function isAlreadyExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function isTransientLockRace(error: unknown): boolean {
  return ["EACCES", "EBUSY", "EEXIST", "ENOENT", "ENOTEMPTY", "EPERM"].includes(errorCode(error));
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null
    ? String((error as NodeJS.ErrnoException).code ?? "")
    : "";
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  // bootstrap 的 filesystem seed 本身是同步启动边界；这里短暂阻塞当前 Agent
  // 进程，换取跨进程同版本缓存只有一个写入者。
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
