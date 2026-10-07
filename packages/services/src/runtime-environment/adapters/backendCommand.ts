import { execFile, type ExecFileException } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";

export const BACKEND_COMMAND_TIMEOUT_MS = 600_000;
const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface BackendCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function throwIfBackendAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException("The operation was aborted", "AbortError");
  }
}

export function runBackendCommand(
  executable: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<BackendCommandResult> {
  if (!isAbsolute(executable)) throw new Error("managed backend commands require an absolute executable");
  throwIfBackendAborted(options.signal);
  return new Promise((resolve, reject) => {
    let completion: { error: ExecFileException | null; stdout: string; stderr: string } | undefined;
    const child = execFile(executable, [...args], {
      cwd: tmpdir(),
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs ?? BACKEND_COMMAND_TIMEOUT_MS,
      maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
      signal: options.signal,
    }, (error, stdout, stderr) => {
      completion = { error, stdout, stderr };
    });
    // 根因：execFile 的 AbortError 回调可早于真实退出；此时结算会提前释放安装锁。
    // close 才是本次子进程及 stdio 已关闭的证明，取消/超时/失败都沿同一结算路径。
    child.once("close", (code) => {
      try {
        throwIfBackendAborted(options.signal);
        if (!completion) throw new Error("managed backend process closed without a completion result");
        const { error, stdout, stderr } = completion;
        if (typeof error?.code === "string") throw error;
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : code ?? 1) : code ?? 0,
          stdout,
          stderr: stderr || error?.message || "",
        });
      } catch (error) {
        reject(error);
      }
    });
  });
}
