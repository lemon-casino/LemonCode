import { spawn } from "node:child_process";

/** Commands come from the Host preparation plan or the approved integration candidate. */
export function runWorktreeValidation(
  checkoutPath: string,
  command: string,
  onOutput?: (output: string) => Promise<void>,
  /** 冻结上下文覆盖键值（spec: specs/worktree-runtime-environments.md §9.2）；合并进宿主环境，不改 Host process.env。 */
  env?: Record<string, string>,
): Promise<{ exitCode: number; output: string; outputTruncated: boolean }> {
  // Windows 环境键不区分大小写；PATH/Path 并存时 Node 会择旧值，导致候选实际跑宿主工具。
  // 按大小写无关键去重并让冻结覆盖最后生效，不修改 Host process.env。
  const environment: NodeJS.ProcessEnv = {};
  for (const source of [process.env, env ?? {}]) {
    for (const [key, value] of Object.entries(source)) {
      if (process.platform === "win32") {
        const existing = Object.keys(environment).find((name) => name.toLowerCase() === key.toLowerCase());
        if (existing) delete environment[existing];
      }
      environment[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: checkoutPath,
      env: environment,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let outputTruncated = false;
    let timedOut = false;
    let progress: Promise<void> | undefined;
    let pendingOutput = "";
    let progressError: unknown;
    const append = (chunk: string) => {
      // 截断由真正读取 pipe 的适配器记录，不能因返回值刚好等于上限就误报完整日志。
      outputTruncated ||= output.length + chunk.length > 64 * 1024;
      output = `${output}${chunk}`.slice(-64 * 1024);
      if (!onOutput || progressError) return;
      // 大量输出只保留有界待写缓冲，不为每个 chunk 创建无限 Promise 队列。
      pendingOutput = `${pendingOutput}${chunk}`.slice(-64 * 1024);
      if (!progress)
        progress = (async () => {
          while (pendingOutput) {
            const buffered = pendingOutput;
            pendingOutput = "";
            await onOutput(buffered);
          }
        })()
          .catch((error) => {
            progressError = error;
          })
          .finally(() => {
            progress = undefined;
          });
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32" && child.pid) {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        killer.once("error", () => child.kill("SIGKILL"));
      } else child.kill("SIGKILL");
    }, 300_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", async (code) => {
      clearTimeout(timeout);
      await progress;
      if (progressError) {
        reject(progressError);
        return;
      }
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output, outputTruncated });
    });
  });
}
