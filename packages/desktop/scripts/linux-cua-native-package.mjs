import { isAbsolute, resolve } from "node:path";

export const LINUX_CUA_XA11Y_NATIVE_ROOT_ENV = "ZCODE_CUA_LINUX_XA11Y_NATIVE_ROOT";

const LINUX_XA11Y_NATIVE_PACKAGES = Object.freeze({
  arm64: "@crowecawcaw/xa11y-linux-arm64-gnu",
  x64: "@crowecawcaw/xa11y-linux-x64-gnu",
});

/**
 * Resolves the release-built xa11y package for Linux packaging only.
 * The runtime stager remains the owner of package identity, version, ELF, and file validation.
 */
export function resolveLinuxCuaNativePackageRoots({ targetPlatform, env = process.env }) {
  if (targetPlatform?.os !== "linux") {
    return undefined;
  }

  const packageName = LINUX_XA11Y_NATIVE_PACKAGES[targetPlatform.arch];
  if (!packageName) {
    throw new Error(
      `[linux-cua-native-package] unsupported Linux architecture: ${String(targetPlatform.arch)}`,
    );
  }

  const configuredRoot = env[LINUX_CUA_XA11Y_NATIVE_ROOT_ENV]?.trim();
  if (!configuredRoot) {
    // 根因：npm 发布的 xa11y 预编译件可能继承高于产品基线的 glibc，Linux 出包必须显式
    // 消费 manylinux_2_28 构建产物，不能静默退回当前 node_modules 中的二进制。
    throw new Error(
      `[linux-cua-native-package] ${LINUX_CUA_XA11Y_NATIVE_ROOT_ENV} is required for Linux packaging`,
    );
  }
  if (!isAbsolute(configuredRoot)) {
    throw new Error(
      `[linux-cua-native-package] ${LINUX_CUA_XA11Y_NATIVE_ROOT_ENV} must be an absolute path`,
    );
  }

  return { [packageName]: resolve(configuredRoot) };
}
