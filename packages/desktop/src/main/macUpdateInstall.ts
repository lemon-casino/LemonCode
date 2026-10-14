import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

interface MacUpdateInstallOptions {
  dmgPath: string;
  ownerPid?: number;
  /** 调用方必须已完成既有 Host/Agent 退出准备。 */
  exitApp: () => void;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
}

// 修复依据：运行中的 Electron 保留旧 ASAR 索引；先展示 DMG 会让用户在旧 Main
// 退出前替换应用包，随后首页读取落入新包的 WASM 字节。独立系统进程必须确认
// 本次 Main PID 已消失才打开镜像，不能靠固定延迟推断退出完成。
const OPEN_AFTER_OWNER_EXIT = `while kill -0 "$1" 2>/dev/null; do
  /bin/sleep 0.1 || exit 1
done
exec "$3" "$2"`;

export async function openMacUpdateDmgAfterExit(options: MacUpdateInstallOptions): Promise<void> {
  const ownerPid = options.ownerPid ?? process.pid;
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) {
    throw new Error("macOS update handoff requires a valid Main PID");
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  const helper = spawnProcess(
    "/bin/sh",
    [
      "-c",
      OPEN_AFTER_OWNER_EXIT,
      "lcode-mac-update",
      String(ownerPid),
      options.dmgPath,
      "/usr/bin/open",
    ],
    { detached: true, stdio: "ignore", cwd: "/" },
  );
  // spawn() 返回对象不代表系统进程已创建。只有收到 spawn 后才允许旧 Main 退出；
  // EACCES/ENOENT 等启动失败交回 autoUpdater 的现有 ready/重试路径。
  await new Promise<void>((resolve, reject) => {
    helper.once("error", reject);
    helper.once("spawn", resolve);
  });
  helper.unref();
  try {
    options.exitApp();
  } catch (error) {
    // 退出入口失败意味着交接未完成，不能让 helper 在以后普通退出时误打开镜像。
    helper.kill();
    throw error;
  }
}
