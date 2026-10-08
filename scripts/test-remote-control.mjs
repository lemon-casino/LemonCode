// tag 构建与本地使用同一组远控回归；UI 源码测试通过当前 tsconfig 解析别名。
import { spawn } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "..");
const files = [
  "packages/shared/src/remoteControlBridgeFrame.test.ts",
  "packages/desktop/src/main/desktopRemoteControlController.test.ts",
  "packages/desktop/src/main/desktopRemoteControlTunnel.test.ts",
  "packages/desktop/src/main/desktopRemoteControlFramePump.test.ts",
  "packages/ui/src/settings/MobileRemoteControlPanel.test.tsx",
  "packages/web/test/pairingCredentialStore.test.mjs",
  "packages/web/test/pairingFrames.test.mjs",
];
const code = await new Promise((resolveExit, reject) => {
  const child = spawn(process.execPath, ["--import", "tsx", "--test", ...files], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(root, "packages/ui/tsconfig.json") },
  });
  child.once("error", reject);
  child.once("exit", (value) => resolveExit(value ?? 1));
});
process.exitCode = code;
