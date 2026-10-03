import { spawn } from "node:child_process";

/** Commands come from the explicitly confirmed integration request. */
export function runWorktreeValidation(
  checkoutPath: string,
  command: string,
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
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1024);
    };
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
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: timedOut ? 124 : (code ?? 1), output });
    });
  });
}
