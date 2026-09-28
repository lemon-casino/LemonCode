import process from "node:process";

function normalizeTargetOs(rawOs) {
  const value = (rawOs ?? "").toLowerCase();
  switch (value) {
    case "mac":
    case "macos":
    case "darwin":
    case "osx":
      return "darwin";
    case "win":
    case "windows":
    case "win32":
      return "win32";
    case "linux":
      return "linux";
    default:
      throw new Error(`Unsupported target OS: ${rawOs}`);
  }
}

function normalizeTargetArch(rawArch) {
  const value = (rawArch ?? "").toLowerCase();
  switch (value) {
    case "x64":
    case "amd64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`Unsupported target arch: ${rawArch}`);
  }
}

export function getTargetPlatform() {
  const targetOs = process.env.LCODE_TARGET_OS ?? process.platform;
  const targetArch = process.env.LCODE_TARGET_ARCH ?? process.arch;
  const os = normalizeTargetOs(targetOs);
  const arch = normalizeTargetArch(targetArch);

  return {
    os,
    arch,
    key: `${os}-${arch}`,
    npmOs: os,
    npmCpu: arch,
    // 部分 Linux optional native 包声明了 libc=glibc。
    // 跨平台 prepare 时如果只传 --os/--cpu，npm 仍会按宿主机 libc 判定为不匹配，导致补装失败。
    npmLibc: os === "linux" ? "glibc" : undefined,
  };
}

export function resolvePlatformKeyForPackagedApp() {
  return `${process.platform}-${process.arch}`;
}
