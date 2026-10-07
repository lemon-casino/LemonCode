#!/usr/bin/env node

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchReleasePlan } from "../../../scripts/native-search-tools-config.mjs";
import { runCommand } from "../../../scripts/spawn-command.mjs";
import { getTargetPlatform } from "./target-platform.mjs";
import { prepareMiseRuntimeAssets, resolveMiseTarget } from "./prepare-mise-runtime-assets.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const target = getTargetPlatform();
const miseTarget = {
  os: target.os,
  arch: target.arch,
  libc: process.env.LCODE_MISE_LIBC ?? process.env.LCODE_TARGET_LIBC,
};
await prepareMiseRuntimeAssets({ target: resolveMiseTarget(miseTarget) });
const nativeSearchReleasePlan = resolveNativeSearchReleasePlan({
  platform: target.os,
  arch: target.arch,
});
// Windows Chrome 导入入口未启用，默认构建继续编译 helper 会增加 CI 时间和发布签名面。
// 保留显式开关，后续恢复入口时仍可复用既有原生实现和供应链校验。
const shouldPrepareWindowsBrowserImportHelper =
  target.os === "win32" && process.env.LCODE_ENABLE_WINDOWS_BROWSER_IMPORT === "1";
// CUA 权限浮窗的吸附数据源。仅 macOS；缺 swiftc 时脚本内部自行降级为跳过（浮窗 fail-open
// 到屏幕底部，仍可用），所以无条件挂在 darwin 上不会让构建变脆。
const shouldPrepareMacosWindowBounds = target.os === "darwin";

// 修复依据：桌面包只消费目标平台资产；远端预构建会校验异构 mise 归档，可能让本地打包无期限等待。
// 本机桌面包内置 agent 的 JS bundle（prepare:agent-bundle），运行时由 app 的 Electron Node runtime 执行。
// 远端跨平台原生二进制由显式 prepare:remote-assets 单独准备，桌面打包只准备目标平台资产。
// native-search 归档随仓库分发，准备步骤只做本地解包校验，不需要任何下载源配置。
const localRuntimeScripts = [
  "prepare:agent-bundle",
  ...(nativeSearchReleasePlan.enabled ? ["prepare:native-search"] : []),
  ...(shouldPrepareWindowsBrowserImportHelper ? ["prepare:browser-import-helper"] : []),
  ...(shouldPrepareMacosWindowBounds ? ["prepare:macos-window-bounds"] : []),
];

function runTimedPnpmScript(scriptName) {
  const startMs = Date.now();
  console.log(`[ci][timer] prepare-runtime-assets:${scriptName} start`);
  try {
    runCommand(pnpmCommand, [scriptName], {
      cwd: desktopRoot,
      env: process.env,
    });
  } finally {
    console.log(
      `[ci][timer] prepare-runtime-assets:${scriptName} end duration_ms=${Date.now() - startMs}`,
    );
  }
}

for (const scriptName of localRuntimeScripts) {
  runTimedPnpmScript(scriptName);
}
