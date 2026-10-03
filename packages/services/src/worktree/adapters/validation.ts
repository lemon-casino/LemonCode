import { spawn } from "node:child_process";

/** Commands come from the Host preparation plan or the approved integration candidate. */
export function runWorktreeValidation(
  checkoutPath: string,
  command: string,
  onOutput?: (output: string) => Promise<void>,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd: checkoutPath,
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let timedOut = false;
    let progress: Promise<void> | undefined;
    let pendingOutput = "";
    let progressError: unknown;
    const append = (chunk: string) => {
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
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output });
    });
  });
}
