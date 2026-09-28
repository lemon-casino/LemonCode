import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "..");
const desktopRoot = resolve(workspaceRoot, "packages/desktop");
const enableHostInspect = process.argv.includes("--host-inspect");

function resolveElectronExecutable() {
  if (process.platform === "darwin") {
    return resolve(
      workspaceRoot,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
  }
  if (process.platform === "win32") {
    return resolve(workspaceRoot, "node_modules/electron/dist/electron.exe");
  }
  return resolve(workspaceRoot, "node_modules/electron/dist/electron");
}

const electronExecutable = resolveElectronExecutable();

if (!existsSync(electronExecutable)) {
  console.error(`[lcode-debug] Electron executable not found: ${electronExecutable}`);
  process.exit(1);
}

const child = spawn(electronExecutable, ["--inspect-brk=9231", "."], {
  cwd: desktopRoot,
  stdio: "inherit",
  env: {
    ...process.env,
    // 调试启动时 renderer 也必须走 localhost。
    // 否则即使 Vite 已经就绪，Electron 仍会因为访问 127.0.0.1 被拒绝而打开空白页。
    ELECTRON_RENDERER_URL: "http://localhost:5174",
    ...(enableHostInspect ? { LCODE_DEBUG: "9230" } : {}),
  },
});

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
