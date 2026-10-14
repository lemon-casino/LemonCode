import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { IRemoteBackend, StdioStream } from "@lcode/server/remote/backend.js";
import { REMOTE_BASE } from "@lcode/server/remote/deployShared.js";
import { quotePosixPathArg, quotePosixShellArg } from "@lcode/server/remote/posixShell.js";

const DEPLOY_LOCK_HEARTBEAT_SECONDS = 30;
const DEPLOY_LOCK_STALE_SECONDS = 600;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 120_000;
const DEFAULT_RELEASE_TIMEOUT_MS = 5_000;
const MAX_LOCK_STDERR_LENGTH = 4_096;

export interface RemoteDeployLockHandle {
  ownerToken: string;
  release(): Promise<void>;
}

export interface AcquireRemoteDeployLockOptions {
  lockDir?: string;
  ownerToken?: string;
  acquireTimeoutMs?: number;
  releaseTimeoutMs?: number;
}

function destroyStreamBestEffort(stream: NodeJS.ReadableStream | NodeJS.WritableStream): void {
  try {
    (stream as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
  } catch {
    // release timeout 后只尽力关闭本次 lock-holder stream；清理失败不能再次覆盖 timeout 诊断。
  }
}

function destroyLockStreamBestEffort(stream: StdioStream): void {
  try {
    // SSH channel destroy 不保证远端 waiter 收到 EOF；先结束 stdin，交由锁脚本释放自己的状态。
    stream.stdin.end();
  } catch {
    // 半开通道仍依靠远端 acquisition deadline 收敛。
  }
  destroyStreamBestEffort(stream.stdin);
  destroyStreamBestEffort(stream.stdout);
  destroyStreamBestEffort(stream.stderr);
}

function buildRemoteDeployLockScript(
  lockDir: string,
  ownerToken: string,
  acquireTimeoutMs: number,
): string {
  const acquiredMarker = `lcode-deploy-lock-acquired:${ownerToken}`;
  const releaseMarker = `lcode-deploy-lock-release:${ownerToken}`;
  return [
    "set -eu",
    `lock_dir=${quotePosixPathArg(lockDir)}`,
    `owner_token=${quotePosixShellArg(ownerToken)}`,
    'owner_file="$lock_dir/owner"',
    'stale_dir="$lock_dir.stale-$owner_token"',
    `control_file=${quotePosixPathArg(`${lockDir}.control-${ownerToken}`)}`,
    'control_temp="$control_file.tmp"',
    "control_reader_pid=",
    `mkdir -p ${quotePosixPathArg(posix.dirname(lockDir))}`,
    "cleanup_deploy_lock() {",
    '  if [ -n "${control_reader_pid:-}" ]; then if [ ! -f "$control_file" ]; then kill -KILL "$control_reader_pid" >/dev/null 2>&1 || true; fi; wait "$control_reader_pid" 2>/dev/null || true; fi',
    '  current_owner=$(cat "$owner_file" 2>/dev/null || true)',
    '  if [ "$current_owner" = "$owner_token" ]; then rm -rf "$lock_dir"; fi',
    '  rm -f "$control_file" "$control_temp"',
    "}",
    "trap cleanup_deploy_lock EXIT",
    "trap 'exit 1' HUP INT TERM",
    // 原脚本取得锁后才 read stdin，断连的 waiter 仍会无限 mkdir 排队。
    // POSIX 后台命令默认 stdin=/dev/null；显式复制 fd 保留本次 exec 的 EOF/release 控制面。
    "exec 3<&0",
    '(release_marker=; IFS= read -r release_marker || true; printf %s "$release_marker" > "$control_temp"; command mv -f "$control_temp" "$control_file") <&3 >/dev/null 2>&1 &',
    "control_reader_pid=$!",
    "exec 3<&-",
    `lock_deadline=$(( $(date +%s) + ${Math.ceil(acquireTimeoutMs / 1000)} ))`,
    "while :; do",
    '  if [ -f "$control_file" ]; then echo "[deploy-lock] connection ended while waiting for lock" >&2; exit 1; fi',
    `  if [ "$(date +%s)" -ge "$lock_deadline" ]; then echo ${quotePosixShellArg(`[deploy-lock] remote lock acquisition timed out after ${acquireTimeoutMs}ms (owner=${ownerToken})`)} >&2; exit 1; fi`,
    '  if mkdir "$lock_dir" 2>/dev/null; then break; fi',
    '  lock_mtime=$({ stat -c %Y "$owner_file" || stat -f %m "$owner_file" || stat -c %Y "$lock_dir" || stat -f %m "$lock_dir"; } 2>/dev/null || printf 0)',
    "  lock_now=$(date +%s)",
    `  if [ "$lock_mtime" -gt 0 ] && [ $((lock_now - lock_mtime)) -ge ${DEPLOY_LOCK_STALE_SECONDS} ]; then`,
    '    if command mv "$lock_dir" "$stale_dir" 2>/dev/null; then rm -rf "$stale_dir"; fi',
    "    continue",
    "  fi",
    "  sleep 1",
    "done",
    'printf %s "$owner_token" > "$owner_file"',
    `printf '%s\n' ${quotePosixShellArg(acquiredMarker)}`,
    "next_heartbeat=0",
    'while [ ! -f "$control_file" ]; do',
    '  if [ "$(cat "$owner_file" 2>/dev/null || true)" != "$owner_token" ]; then echo "[deploy-lock] owner changed while holding lock" >&2; exit 1; fi',
    "  lock_now=$(date +%s)",
    `  if [ "$lock_now" -ge "$next_heartbeat" ]; then touch "$owner_file"; next_heartbeat=$((lock_now + ${DEPLOY_LOCK_HEARTBEAT_SECONDS})); fi`,
    "  sleep 1",
    "done",
    'release_marker=$(cat "$control_file")',
    // EOF 同样结束当前 owner；释放只做 owner 比对，绝不清理其他连接的锁。
    'if [ -z "$release_marker" ]; then exit 0; fi',
    `if [ "$release_marker" != ${quotePosixShellArg(releaseMarker)} ]; then echo ${quotePosixShellArg("[deploy-lock] invalid release marker")} >&2; exit 1; fi`,
  ].join("\n");
}

function encodePosixOctal(value: string): string {
  return Array.from(
    Buffer.from(value, "utf8"),
    (byte) => `\\${byte.toString(8).padStart(3, "0")}`,
  ).join("");
}

function buildRemoteDeployLockCommand(
  lockDir: string,
  ownerToken: string,
  acquireTimeoutMs: number,
): string {
  const scriptPath = `${lockDir}.holder-${ownerToken}.sh`;
  const script = buildRemoteDeployLockScript(lockDir, ownerToken, acquireTimeoutMs);
  // wsl.exe 会先经默认 shell 重组 `bash -lc` 参数，脚本里的局部 `$var`
  // 会在真正的 shell 执行前被展开为空。用纯八进制内容落盘后再执行，同时保留 stdin 给 release marker。
  // 锁脚本只使用 POSIX 语法，显式用 sh 执行，兼容 Alpine/BusyBox 等没有 bash 的远端。
  return [
    "set -eu",
    `mkdir -p ${quotePosixPathArg(posix.dirname(scriptPath))}`,
    `printf '%b' ${quotePosixShellArg(encodePosixOctal(script))} > ${quotePosixPathArg(scriptPath)}`,
    `trap ${quotePosixShellArg(`rm -f ${quotePosixPathArg(scriptPath)}`)} EXIT HUP INT TERM`,
    `sh ${quotePosixPathArg(scriptPath)}`,
  ].join("\n");
}

function createStreamClosePromise(stream: StdioStream): {
  promise: Promise<number>;
  readonly code: number | undefined;
  dispose(): void;
} {
  let disposable: { dispose(): void } | undefined;
  let exitCode: number | undefined;
  const promise = new Promise<number>((resolve) => {
    disposable = stream.onClose((code) => {
      exitCode = code;
      resolve(code);
    });
  });
  return {
    promise,
    get code() {
      return exitCode;
    },
    dispose() {
      disposable?.dispose();
    },
  };
}

export async function acquireRemoteDeployLock(
  backend: IRemoteBackend,
  options: AcquireRemoteDeployLockOptions = {},
): Promise<RemoteDeployLockHandle> {
  const ownerToken = options.ownerToken?.trim() || randomUUID();
  const lockDir = options.lockDir?.trim() || `${REMOTE_BASE}/.deploy.lock`;
  const acquireTimeoutMs = Math.max(
    1,
    Math.floor(options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS),
  );
  const releaseTimeoutMs = Math.max(
    1,
    Math.floor(options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS),
  );
  const acquiredMarker = `lcode-deploy-lock-acquired:${ownerToken}`;
  const releaseMarker = `lcode-deploy-lock-release:${ownerToken}`;
  const stream = await backend.exec(
    buildRemoteDeployLockCommand(lockDir, ownerToken, acquireTimeoutMs),
  );
  const close = createStreamClosePromise(stream);
  let stderrText = "";
  const onStderr = (chunk: Buffer | string) => {
    stderrText = `${stderrText}${chunk.toString()}`.slice(-MAX_LOCK_STDERR_LENGTH);
  };
  stream.stderr.on("data", onStderr);

  try {
    await new Promise<void>((resolve, reject) => {
      let stdoutBuffer = "";
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        stream.stdout.off("data", onStdout);
        if (timeout) {
          clearTimeout(timeout);
        }
      };
      const onStdout = (chunk: Buffer | string) => {
        stdoutBuffer = `${stdoutBuffer}${chunk.toString()}`.slice(-MAX_LOCK_STDERR_LENGTH);
        if (!stdoutBuffer.includes(acquiredMarker) || settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve();
      };
      const onTimeout = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        // 其他 owner 持续 heartbeat 时 stale recovery 永远不会触发，waiter 会永久挂住。
        // deadline 后只销毁本次 waiter 的 stream，不删除远端 lock，也不 dispose 共享 backend。
        destroyLockStreamBestEffort(stream);
        reject(
          new Error(
            `[deploy-lock] lock acquisition timed out after ${acquireTimeoutMs}ms (owner=${ownerToken})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      };
      // 先安装 deadline 再订阅 stdout；某些 stream 在注册 data listener 时会同步吐出缓冲 marker。
      // 若顺序相反，marker 已 resolve 后才创建的 timer 会残留到 deadline。
      timeout = setTimeout(onTimeout, acquireTimeoutMs);
      stream.stdout.on("data", onStdout);
      void close.promise.then((code) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(
          new Error(
            `[deploy-lock] lock-holder exited before acquisition (code=${code})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          ),
        );
      });
    });
  } catch (error) {
    destroyLockStreamBestEffort(stream);
    stream.stderr.off("data", onStderr);
    close.dispose();
    throw error;
  }

  let releasePromise: Promise<void> | null = null;
  return {
    ownerToken,
    release() {
      if (releasePromise) {
        return releasePromise;
      }
      releasePromise = (async () => {
        try {
          // 断连已让脚本退出时不再往关闭的 stdin 写 marker，避免二次释放触发 EPIPE。
          if (close.code !== undefined) {
            if (close.code !== 0) {
              throw new Error(`[deploy-lock] lock-holder already exited (code=${close.code})`);
            }
            return;
          }
          stream.stdin.write(`${releaseMarker}\n`);
          stream.stdin.end();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          const timeoutError = new Error(
            `[deploy-lock] lock-holder release timed out after ${releaseTimeoutMs}ms (owner=${ownerToken})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
          );
          let code: number;
          try {
            code = await Promise.race([
              close.promise,
              new Promise<never>((_resolve, reject) => {
                timeout = setTimeout(() => reject(timeoutError), releaseTimeoutMs);
              }),
            ]);
          } catch (error) {
            if (error === timeoutError) {
              // 远端半开或 close 事件丢失会让 deployServer 永久卡在 finally。
              // deadline 后只销毁当前 owner 的 stdio，让 backend 后续 dispose 接管底层连接回收。
              destroyLockStreamBestEffort(stream);
            }
            throw error;
          } finally {
            if (timeout) {
              clearTimeout(timeout);
            }
          }
          if (code !== 0) {
            throw new Error(
              `[deploy-lock] lock-holder release failed (code=${code})${stderrText.trim() ? `: ${stderrText.trim()}` : ""}`,
            );
          }
        } finally {
          stream.stderr.off("data", onStderr);
          close.dispose();
        }
      })();
      return releasePromise;
    },
  };
}

/** 安装目录与组件缓存复用同一事务边界，释放失败不能覆盖真正的部署失败。 */
export async function withRemoteDeployLock<T>(
  backend: IRemoteBackend,
  options: AcquireRemoteDeployLockOptions,
  task: (handle: RemoteDeployLockHandle) => Promise<T>,
): Promise<T> {
  const handle = await acquireRemoteDeployLock(backend, options);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await task(handle) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  try {
    await handle.release();
  } catch (error) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, error],
        "remote deployment and deploy-lock release both failed",
      );
    }
    throw error;
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
