import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const LEGACY_ZCODE_RESERVED_IDENTITY = Object.freeze({
  appId: "dev.zcode.app",
  productName: "ZCode",
  linuxExecutableName: "zcode",
  linuxPackageName: "zcode",
});

const linuxArtifactArchitectures = Object.freeze({
  x64: Object.freeze({ AppImage: "x86_64", deb: "amd64", rpm: "x86_64", pacman: "x64" }),
  arm64: Object.freeze({
    AppImage: "arm64",
    deb: "arm64",
    rpm: "aarch64",
    pacman: "aarch64",
  }),
});

function normalizeIdentityValue(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}

export function assertCrossBrandIdentity(
  identity,
  reservedIdentity = LEGACY_ZCODE_RESERVED_IDENTITY,
) {
  for (const field of ["appId", "productName", "linuxExecutableName", "linuxPackageName"]) {
    const value = normalizeIdentityValue(identity[field]);
    if (!value) throw new Error(`Desktop product identity is missing ${field}`);
    if (value === normalizeIdentityValue(reservedIdentity[field])) {
      throw new Error(`${field} collides with reserved ZCode identity: ${identity[field]}`);
    }
  }
}

function assertTarget(os, arch) {
  if (!["mac", "win", "linux"].includes(os)) {
    throw new Error(`Unsupported desktop target OS: ${os}`);
  }
  if (!["x64", "arm64"].includes(arch)) {
    throw new Error(`Unsupported desktop target architecture: ${arch}`);
  }
}

export function resolvePackagedProductLayout({
  os,
  arch,
  distRoot,
  version,
  identity,
  artifactSuffix = "",
}) {
  assertTarget(os, arch);
  assertCrossBrandIdentity(identity);
  const productName = identity.productName.trim();
  const normalizedVersion = String(version ?? "").trim();
  if (!normalizedVersion)
    throw new Error("Packaged product identity verification requires version");
  if (artifactSuffix !== "" && artifactSuffix !== "_TEST") {
    throw new Error(`Unsupported desktop artifact suffix: ${artifactSuffix}`);
  }

  if (os === "mac") {
    const applicationPath = resolve(
      distRoot,
      arch === "arm64" ? "mac-arm64" : "mac",
      `${productName}.app`,
    );
    return {
      applicationPath,
      executablePath: resolve(applicationPath, "Contents", "MacOS", productName),
      artifactPaths: {
        dmg: resolve(
          distRoot,
          `${productName}-${normalizedVersion}-mac-${arch}${artifactSuffix}.dmg`,
        ),
        zip: resolve(
          distRoot,
          `${productName}-${normalizedVersion}-mac-${arch}${artifactSuffix}.zip`,
        ),
      },
    };
  }

  if (os === "win") {
    return {
      executablePath: resolve(
        distRoot,
        arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked",
        `${productName}.exe`,
      ),
      artifactPaths: {
        nsis: resolve(
          distRoot,
          `${productName}-${normalizedVersion}-win-${arch}${artifactSuffix}.exe`,
        ),
      },
    };
  }

  const artifactArch = linuxArtifactArchitectures[arch];
  return {
    executablePath: resolve(
      distRoot,
      arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked",
      identity.linuxExecutableName,
    ),
    artifactPaths: {
      AppImage: resolve(
        distRoot,
        `${productName}-${normalizedVersion}-linux-${artifactArch.AppImage}${artifactSuffix}.AppImage`,
      ),
      deb: resolve(
        distRoot,
        `${productName}-${normalizedVersion}-linux-${artifactArch.deb}${artifactSuffix}.deb`,
      ),
      rpm: resolve(
        distRoot,
        `${productName}-${normalizedVersion}-linux-${artifactArch.rpm}${artifactSuffix}.rpm`,
      ),
      pacman: resolve(
        distRoot,
        `${productName}-${normalizedVersion}-linux-${artifactArch.pacman}${artifactSuffix}.pkg.tar.zst`,
      ),
    },
  };
}

function runText(command, args, envPatch = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...envPatch },
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  }).trim();
}

function readPacmanPackageName(packagePath) {
  const metadata = runText("bsdtar", ["-xOf", packagePath, ".PKGINFO"]);
  return metadata.match(/^pkgname\s*=\s*(.+)$/mu)?.[1]?.trim() ?? "";
}

function readDefaultNativeIdentity({ kind, path }) {
  if (kind === "mac-bundle") {
    const plistPath = resolve(path, "Contents", "Info.plist");
    return {
      appId: runText("plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", plistPath]),
      productName: runText("plutil", ["-extract", "CFBundleName", "raw", "-o", "-", plistPath]),
    };
  }
  if (kind === "windows-pe") {
    const script =
      "$item = Get-Item -LiteralPath $env:LCODE_PACKAGED_IDENTITY_PATH; " +
      "[Console]::Out.Write($item.VersionInfo.ProductName)";
    return {
      productName: runText(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          LCODE_PACKAGED_IDENTITY_PATH: path,
        },
      ),
    };
  }
  if (kind === "linux-deb") {
    return { packageName: runText("dpkg-deb", ["--field", path, "Package"]) };
  }
  if (kind === "linux-rpm") {
    return {
      packageName: runText("rpm", ["--query", "--package", "--queryformat", "%{NAME}", path]),
    };
  }
  if (kind === "linux-pacman") {
    return { packageName: readPacmanPackageName(path) };
  }
  throw new Error(`Unsupported native identity reader: ${kind}`);
}

function assertNonemptyFile(path, label) {
  const file = existsSync(path) ? statSync(path) : null;
  if (!file?.isFile() || file.size === 0) {
    throw new Error(`Missing or empty ${label}: ${path}`);
  }
}

function assertEqualIdentity(label, actual, expected) {
  if (normalizeIdentityValue(actual) !== normalizeIdentityValue(expected)) {
    throw new Error(`${label} identity ${actual || "<empty>"} does not match ${expected}`);
  }
}

export function verifyPackagedProductIdentity({
  os,
  arch,
  distRoot,
  version,
  identity,
  artifactSuffix = "",
  readNativeIdentity = readDefaultNativeIdentity,
}) {
  const layout = resolvePackagedProductLayout({
    os,
    arch,
    distRoot,
    version,
    identity,
    artifactSuffix,
  });
  assertNonemptyFile(layout.executablePath, `${os} unpacked executable`);
  for (const [format, path] of Object.entries(layout.artifactPaths)) {
    assertNonemptyFile(path, `${os} ${format} artifact`);
  }

  // 修复依据：品牌迁移后的正式包必须以产物元数据为准；只检查配置或文件名会放过
  // macOS Bundle ID、Windows PE ProductName、Linux 原生包名仍指向 ZCode 的坏包。
  if (os === "mac") {
    const metadata = readNativeIdentity({ kind: "mac-bundle", path: layout.applicationPath });
    assertEqualIdentity("macOS CFBundleIdentifier", metadata.appId, identity.appId);
    assertEqualIdentity("macOS CFBundleName", metadata.productName, identity.productName);
  } else if (os === "win") {
    for (const [label, path] of [
      ["Windows executable ProductName", layout.executablePath],
      ["Windows NSIS ProductName", layout.artifactPaths.nsis],
    ]) {
      const metadata = readNativeIdentity({ kind: "windows-pe", path });
      assertEqualIdentity(label, metadata.productName, identity.productName);
    }
  } else {
    for (const format of ["deb", "rpm", "pacman"]) {
      const metadata = readNativeIdentity({
        kind: `linux-${format}`,
        path: layout.artifactPaths[format],
      });
      assertEqualIdentity(
        `Linux ${format} package name`,
        metadata.packageName,
        identity.linuxPackageName,
      );
    }
  }

  return { os, arch, productName: identity.productName, layout };
}

export function readPackagedBuildVersion(desktopRoot) {
  const metadataPath = resolve(desktopRoot, "out", "metadata", "build-meta.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const version = String(metadata.appVersion ?? "").trim();
  if (!version) throw new Error(`Packaged build metadata is missing appVersion: ${metadataPath}`);
  return version;
}
