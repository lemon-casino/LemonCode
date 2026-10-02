import { open, readFile, rm, stat, unlink, type FileHandle } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { uptime } from "node:os";

export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 10;

// 进程启动时间的比较容差：ps/proc 的秒级精度 + 调度延迟，2s 足以覆盖且不放过复用。
const LOCK_START_TIME_TOLERANCE_MS = 2_000;
const PROC_CLOCK_TICKS_PER_SECOND = 100;

const execFileAsync = promisify(execFile);

interface LockOwnerMetadata {
  pid: number;
  token: string;
  /** 进程实例启动时间（墙钟 ms）；上一版锁格式无此字段（undefined）。 */
  startTime?: number;
}

export async function defaultWriteLockOwnerMetadata(
  handle: FileHandle,
  content: string,
): Promise<void> {
  await handle.writeFile(content, "utf8");
}

/** 本进程启动时间的墙钟毫秒（惰性缓存：进程生命周期内不变）。 */
let ownStartTimeMs: number | undefined;
function currentProcessStartTimeMs(): number {
  if (ownStartTimeMs === undefined) {
    ownStartTimeMs = Math.round(Date.now() - uptime() * 1_000);
  }
  return ownStartTimeMs;
}

/**
 * 查询指定 pid 的当前进程实例启动时间（墙钟毫秒）；无法确定时返回 null。
 * 用于 stale 回收时区分「原 owner 实例仍存活」与「pid 已被复用给无关进程」
 * （裸 pid 只标识进程表槽位，不具备跨时间唯一性）。
 * - linux: /proc/<pid>/stat 字段 22（boot 后 ticks）
 * - darwin: ps -o lstart=
 * - win32: powershell Get-Process StartTime（成本较高，但只在超龄回收路径触发）
 * - 失败/不支持 → null，调用方保守视为原 owner 存活（不回收）。
 */
export async function probeProcessStartTimeDefault(pid: number): Promise<number | null> {
  if (pid === process.pid) return currentProcessStartTimeMs();
  try {
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // ')' 之后 token[0] 是 state（字段 3）；starttime 是字段 22 → token[19]。
      const tokens = stat.slice(close + 2).split(" ");
      const ticks = Number(tokens[19]);
      if (!Number.isFinite(ticks)) return null;
      const bootMs = Date.now() - uptime() * 1_000;
      return Math.round(bootMs + (ticks * 1_000) / PROC_CLOCK_TICKS_PER_SECOND);
    }
    if (process.platform === "darwin") {
      const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)]);
      const parsed = Date.parse(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-Command",
        `[DateTimeOffset]::new((Get-Process -Id ${pid}).StartTime).ToUnixTimeMilliseconds()`,
      ]);
      const parsed = Number(stdout.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface WorkspaceHookTrustLockOptions {
  readonly lockPath: string;
  readonly lockTimeoutMs: number;
  readonly staleLockMs: number;
  readonly probeProcessStartTime: (pid: number) => Promise<number | null>;
  readonly writeLockOwnerMetadata: (handle: FileHandle, content: string) => Promise<void>;
}

export async function withWorkspaceHookTrustLock<T>(
  options: WorkspaceHookTrustLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const { handle, token } = await acquireLock(options);
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => undefined);
    // 释放前必须验证所有权。本进程的锁可能已被 stale 回收并归属
    // 新持有者；无条件 unlink 会删掉新持有者的锁，让后续 writer 与之并发
    // 进入临界区，造成基于旧快照的 read-modify-write 覆盖已提交的 revoke/grant。
    await releaseLockIfOwned(options, token);
  }
}

async function acquireLock(
  options: WorkspaceHookTrustLockOptions,
): Promise<{ handle: FileHandle; token: string }> {
  const startedAt = Date.now();
  while (true) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(options.lockPath, "wx", 0o600);
      // 锁内容写入 pid + 进程启动时间 + 不可预测 owner token。
      // startTime 是进程实例标识——裸 pid 会被系统复用，仅凭
      // process.kill(pid, 0) 判活会把「崩溃后 pid 被复用」的锁误判为
      // 活 owner 而永不回收，revoke/grant 全部卡死。回收侧用 probe 比对
      // 当前实例启动时间与锁内记录来区分原 owner 与复用者。
      const token = randomUUID();
      const owner = `${JSON.stringify({
        pid: process.pid,
        startTime: currentProcessStartTimeMs(),
        token,
      })}\n`;
      await options.writeLockOwnerMetadata(handle, owner);
      return { handle, token };
    } catch (error) {
      // open(wx) 成功但 metadata 写失败（磁盘满等）时，必须关闭句柄
      // 并删除自己刚创建的锁——残留空锁会被后续 writer 当作无主锁回收，
      // 破坏互斥；这里只可能删掉自己 wx 独占创建的文件，无越权风险。
      if (handle) {
        await handle.close().catch(() => undefined);
        await unlink(options.lockPath).catch(() => undefined);
      }
      if (!isNodeError(error, "EEXIST")) throw error;
      await removeStaleLock(options);
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error(`Timed out acquiring Workspace Hook Trust store lock: ${options.lockPath}`);
      }
      await delay(LOCK_RETRY_MS);
    }
  }
}

/** 仅当锁仍属于 token 对应持有者时才删除；无主（缺失/他人）一律不动。 */
async function releaseLockIfOwned(
  options: WorkspaceHookTrustLockOptions,
  token: string,
): Promise<void> {
  const owner = await readLockOwner(options);
  if (!owner || owner.token !== token) return;
  await unlink(options.lockPath).catch(() => undefined);
}

async function readLockOwner(
  options: WorkspaceHookTrustLockOptions,
): Promise<LockOwnerMetadata | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(options.lockPath, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { pid?: unknown }).pid === "number" &&
      typeof (parsed as { token?: unknown }).token === "string"
    ) {
      return {
        pid: (parsed as { pid: number }).pid,
        token: (parsed as { token: string }).token,
        startTime:
          typeof (parsed as { startTime?: unknown }).startTime === "number"
            ? (parsed as { startTime: number }).startTime
            : undefined,
      };
    }
    return null;
  } catch {
    // 旧版本空锁/损坏锁 → 无主。
    return null;
  }
}

/** pid 存活检测：signal 0 探测。EPERM（Windows 无权限）视为存活，ESRCH/EINVAL 视为死亡。 */
function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isNodeError(error, "EPERM");
  }
}

async function removeStaleLock(options: WorkspaceHookTrustLockOptions): Promise<void> {
  try {
    const lockStats = await stat(options.lockPath);
    if (Date.now() - lockStats.mtimeMs <= options.staleLockMs) return;
    // 超龄但持有进程仍存活（休眠/调试暂停/杀毒拖慢 IO）→ 不回收。
    // mtime 无法区分"持有者死亡"与"持有者暂停或慢"；pid 存活检测可以。
    // 无法解析的锁（旧版空文件）无 pid 可查 → 按死亡回收。
    const owner = await readLockOwner(options);
    if (!owner) {
      await rm(options.lockPath, { force: true });
      return;
    }
    if (owner.pid === process.pid) return;
    if (!isProcessAlive(owner.pid)) {
      await rm(options.lockPath, { force: true });
      return;
    }
    // pid 存活 ≠ 原 owner 存活。pid 会被系统复用——原 owner 崩溃后
    // 其 pid 若被分配给无关长命进程，纯 kill(0) 判活会让锁永不回收，
    // revoke/grant 全部卡死。用进程实例启动时间核验：锁内记录的 startTime
    // 与该 pid 当前实例的实际启动时间一致 → 原 owner 确实活着（不回收）；
    // 不一致 → 原 owner 已死、pid 已易主（安全回收）。probe 不可用（平台
    // 不支持/查询失败）或锁记录无 startTime（上一版格式混存窗口）→ 保守
    // 视为原 owner 存活，不回收。
    const currentStart = await options.probeProcessStartTime(owner.pid);
    if (currentStart === null || owner.startTime === undefined) return;
    if (Math.abs(currentStart - owner.startTime) > LOCK_START_TIME_TOLERANCE_MS) {
      await rm(options.lockPath, { force: true });
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
