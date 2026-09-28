#!/usr/bin/env node
// 编译 macOS 窗口 bounds 辅助程序（CUA 权限浮窗的吸附数据源）。
//
// 非 darwin 直接跳过：这个二进制只服务 macOS 的 TCC 授权引导，其他平台没有对应流程。
// 缺少 swiftc（未装 Xcode CLT）时也只警告不失败 —— 吸附是观感增强，拿不到 bounds 时浮窗
// 会 fail-open 到屏幕底部照样可用，不该因此让整个 desktop 构建挂掉。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = join(packageRoot, "native", "macos-window-bounds", "main.swift");
const outputDir = join(packageRoot, "resources", "macos-window-bounds");
const outputPath = join(outputDir, "lcode-window-bounds");

if (process.platform !== "darwin") {
  console.log("[window-bounds] 跳过：仅 macOS 需要");
  process.exit(0);
}

if (!existsSync(sourcePath)) {
  console.error(`[window-bounds] 源文件缺失：${sourcePath}`);
  process.exit(1);
}

function hasSwiftc() {
  try {
    execFileSync("xcrun", ["--find", "swiftc"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

if (!hasSwiftc()) {
  console.warn("[window-bounds] 未找到 swiftc（需 Xcode Command Line Tools）；跳过构建。");
  console.warn("[window-bounds] 权限浮窗仍可用，但不会吸附到系统设置窗口。");
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });

try {
  // 同时产出 arm64 与 x86_64 的 universal 二进制，避免发布包在另一架构上无法执行。
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "arm64-apple-macos11", sourcePath, "-o", `${outputPath}-arm64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "xcrun",
    ["swiftc", "-O", "-target", "x86_64-apple-macos11", sourcePath, "-o", `${outputPath}-x86_64`],
    { stdio: "inherit" },
  );
  execFileSync(
    "lipo",
    ["-create", `${outputPath}-arm64`, `${outputPath}-x86_64`, "-output", outputPath],
    { stdio: "inherit" },
  );
  execFileSync("rm", ["-f", `${outputPath}-arm64`, `${outputPath}-x86_64`]);
  console.log(`[window-bounds] 已构建 universal 二进制：${outputPath}`);
} catch (error) {
  console.warn(
    "[window-bounds] 构建失败；权限浮窗仍可用但不会吸附：",
    error instanceof Error ? error.message : String(error),
  );
  process.exit(0);
}
