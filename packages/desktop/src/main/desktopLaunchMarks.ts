import type { LaunchMarks } from "@lcode/shared";

// 启动计时(epoch ms):T0 进程创建 / T1 main JS / T2 whenReady。T3 在 loadWindow 记。
// 单独成模块，避免被 index.js 的 bootstrap 副作用链拖累（如 desktopHostProcess 也要读这些标记）。
// process.getCreationTime 是 Electron 给 process 扩展的 API；node 环境（含单测）下不存在，需守卫。
const launchCreatedAt =
  (typeof process.getCreationTime === "function" ? process.getCreationTime() : null) ?? Date.now();
const launchMainStart = Date.now();
let launchAppReady = launchMainStart;

export function markMainLaunchAppReady(): void {
  launchAppReady = Date.now();
}

export function getMainLaunchPartialMarks(): Omit<LaunchMarks, "loadUrl"> {
  return { createdAt: launchCreatedAt, mainStart: launchMainStart, appReady: launchAppReady };
}
