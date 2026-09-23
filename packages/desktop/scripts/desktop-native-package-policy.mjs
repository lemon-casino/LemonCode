const SUPPORTED_DESKTOP_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
];

function assertSupportedTargetPlatformKey(targetPlatformKey) {
  if (!SUPPORTED_DESKTOP_PLATFORM_KEYS.includes(targetPlatformKey)) {
    throw new Error(`不支持的桌面目标平台: ${targetPlatformKey}`);
  }
}

export function createDesktopNativePackagePrunePatterns(targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);

  return [
    // PDF 预览已经由 Vite 打进 renderer，pdfjs-dist 的 Canvas optional dependency
    // 只服务 Node 渲染；pnpm 跨平台安装的 8 套 Canvas native 不应带进桌面安装包。
    "!node_modules/@napi-rs/canvas/**",
    "!node_modules/@napi-rs/canvas-*/**",
    // CUA 原生包只进入独立 Helper runtime；主 asar 必须在复制阶段即裁掉，后置扫描再复核。
    "!node_modules/@nut-tree-fork/**",
    "!node_modules/@crowecawcaw/xa11y/**",
    "!node_modules/@crowecawcaw/xa11y-*/**",
    // Linux prebuild 会在 beforePack 复制进 node-pty；源平台包本身不属于桌面运行时。
    "!node_modules/@lydell/node-pty-*/**",
    // 桌面运行时统一使用目标 prebuild，禁止把安装机现场编译物或 ABI bin 缓存带进跨平台包。
    "!node_modules/node-pty/build/**",
    "!node_modules/node-pty/bin/**",
    ...SUPPORTED_DESKTOP_PLATFORM_KEYS.filter((key) => key !== targetPlatformKey).map(
      (key) => `!node_modules/node-pty/prebuilds/${key}/**`,
    ),
  ];
}

function normalizeAsarPath(path) {
  const normalized = path.trim().replaceAll("\\", "/");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export function parseAsarListWithPackState(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(pack|unpack)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`无法解析 asar pack state: ${line}`);
      }
      return { packState: match[1], path: normalizeAsarPath(match[2]) };
    });
}

function isNativeRuntimeFile(path, targetPlatformKey) {
  if (/\.(?:node|dll|dylib|exe)$/i.test(path)) return true;
  return path === `/node_modules/node-pty/prebuilds/${targetPlatformKey}/spawn-helper`;
}

function getForbiddenCuaNativePackage(path) {
  // 这两组原生依赖只属于独立 Helper；无论 asar 标记为 pack 还是 unpack，进入 desktop app
  // 都会扩大原生攻击面，并绕过 Helper resources manifest 的完整性校验。
  if (/(?:^|\/)node_modules\/@nut-tree-fork(?:\/|$)/u.test(path)) {
    return "@nut-tree-fork/**";
  }
  if (/(?:^|\/)node_modules\/@crowecawcaw\/xa11y[^/]*(?:\/|$)/u.test(path)) {
    return "@crowecawcaw/xa11y*";
  }
  return undefined;
}

export function findDesktopNativePackageViolations(entries, targetPlatformKey) {
  assertSupportedTargetPlatformKey(targetPlatformKey);
  const violations = [];

  for (const entry of entries) {
    const { packState, path } = entry;

    const forbiddenCuaNativePackage = getForbiddenCuaNativePackage(path);
    if (forbiddenCuaNativePackage) {
      violations.push(
        `Helper-only CUA native 依赖不得进入 desktop app (${forbiddenCuaNativePackage}): ${path}`,
      );
      continue;
    }

    if (
      path === "/node_modules/@napi-rs/canvas" ||
      path.startsWith("/node_modules/@napi-rs/canvas/") ||
      path.startsWith("/node_modules/@napi-rs/canvas-")
    ) {
      violations.push(`不应打包 renderer 无需的 Canvas native: ${path}`);
      continue;
    }

    if (path.startsWith("/node_modules/@lydell/node-pty-")) {
      violations.push(`不应打包仅用于准备 prebuild 的平台源包: ${path}`);
      continue;
    }

    if (
      path.startsWith("/node_modules/node-pty/build/") ||
      path.startsWith("/node_modules/node-pty/bin/")
    ) {
      violations.push(`不应打包安装机生成的 node-pty 产物: ${path}`);
      continue;
    }

    const nodePtyPrebuildMatch = /^\/node_modules\/node-pty\/prebuilds\/([^/]+)/.exec(path);
    if (nodePtyPrebuildMatch && nodePtyPrebuildMatch[1] !== targetPlatformKey) {
      violations.push(`node-pty 包含非目标平台 prebuild: ${path}`);
      continue;
    }

    if (isNativeRuntimeFile(path, targetPlatformKey) && packState !== "unpack") {
      violations.push(`native 文件仍作为 packed payload 留在 app.asar: ${path}`);
    }
  }

  return violations;
}
