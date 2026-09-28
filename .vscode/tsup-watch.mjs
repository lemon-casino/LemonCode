import { spawn } from "node:child_process";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");

const child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@lcode/desktop", "exec", "tsup", "--watch", "--sourcemap"],
  {
    cwd: workspaceRoot,
    stdio: ["inherit", "pipe", "pipe"],
  },
);

function forward(stream) {
  stream?.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
}

forward(child.stdout);
forward(child.stderr);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (!child.killed) {
      child.kill(signal);
    }
  });
}

child.on("exit", (code, signal) => {
  if (signal != null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
