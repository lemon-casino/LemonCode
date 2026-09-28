import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const workspaceRoot = fileURLToPath(new URL("../", import.meta.url));
// 当前 Vite dev server 只监听 localhost，不接受 127.0.0.1。
// 之前这里一直轮询 127.0.0.1，会导致 preLaunchTask 永远不 ready，后续 Electron 启动任务完全不执行。
const viteUrl = "http://localhost:5174";
let child;

async function isViteReady() {
  try {
    const response = await fetch(viteUrl);
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForServer() {
  while (true) {
    if (await isViteReady()) {
      break;
    }

    if (child?.exitCode != null) {
      process.exit(child.exitCode);
    }

    await sleep(300);
  }
}

child = spawn(
  process.platform === "win32" ? "pnpm.cmd" : "pnpm",
  ["--filter", "@lcode/desktop", "exec", "vite", "dev"],
  {
    cwd: workspaceRoot,
    stdio: "inherit",
  },
);

void waitForServer();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (child != null && !child.killed) {
      child.kill(signal);
      return;
    }

    process.exit(0);
  });
}
if (child != null) {
  child.on("exit", (code, signal) => {
    if (signal != null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}
