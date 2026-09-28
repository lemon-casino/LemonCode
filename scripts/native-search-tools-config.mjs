import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const NATIVE_SEARCH_DEPENDENCIES_DIR = join(
  repoRoot,
  "apps/lcode-cli/dependencies/native-search",
);

export const MACOS_NATIVE_SEARCH_DEPLOYMENT_TARGET = "12.0";
export const LINUX_NATIVE_SEARCH_GLIBC_BASELINE = "2.28";

export const NATIVE_SEARCH_RIPGREP_REVISION = "4649aa9700";

export const NATIVE_SEARCH_BFS_CONFIGURE_ARGS = Object.freeze([
  "--enable-release",
  "--with-oniguruma",
  "--without-libselinux",
  "--without-libacl",
  "--without-liburing",
  "--without-libcap",
]);

export const NATIVE_SEARCH_TOOL_VERSIONS = Object.freeze({
  bfs: "4.1.1",
  ripgrep: "14.1.1",
  ugrep: "7.8.4",
});

export const NATIVE_SEARCH_PREBUILT_RELEASES = Object.freeze({
  bfs: `v${NATIVE_SEARCH_TOOL_VERSIONS.bfs}-1`,
  ripgrep: `v${NATIVE_SEARCH_TOOL_VERSIONS.ripgrep}-1`,
  ugrep: `v${NATIVE_SEARCH_TOOL_VERSIONS.ugrep}-1`,
});

const NATIVE_SEARCH_PREBUILT_RELEASE_OVERRIDES = Object.freeze({
  linux: Object.freeze({
    bfs: `v${NATIVE_SEARCH_TOOL_VERSIONS.bfs}-2`,
  }),
});

export const NATIVE_SEARCH_SOURCE_ARCHIVES = Object.freeze([
  {
    id: "bfs",
    version: NATIVE_SEARCH_TOOL_VERSIONS.bfs,
    url: "https://codeload.github.com/tavianator/bfs/tar.gz/f220fb5afd8dd7f46b1d1a2ae9c36261eaccf3cd",
    sha256: "26a122dbafc81f42a60f32d842ca5b4f30c943ba2efff1d61db827bda5efe742",
  },
  {
    id: "ugrep",
    version: NATIVE_SEARCH_TOOL_VERSIONS.ugrep,
    url: "https://codeload.github.com/Genivia/ugrep/tar.gz/550599a6434fc5315fb6ecd415a5d859e6d846a8",
    sha256: "0b3ed2dc7c3902d89f2ef8b66961db2e31a32f240fa2a2e0eb8d559827f36dab",
  },
  {
    id: "oniguruma",
    version: "6.9.10",
    url: "https://github.com/kkos/oniguruma/releases/download/v6.9.10/onig-6.9.10.tar.gz",
    sha256: "2a5cfc5ae259e4e97f86b68dfffc152cdaffe94e2060b770cb827238d769fc05",
  },
  {
    id: "pcre2",
    version: "10.43",
    url: "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.43/pcre2-10.43.tar.gz",
    sha256: "889d16be5abb8d05400b33c25e151638b8d4bac0e2d9c76e9d6923118ae8a34e",
  },
  {
    id: "zlib",
    version: "1.3.1",
    url: "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz",
    sha256: "9a93b2b7dfdac77ceba5a558a580e74667dd6fede4585b91eefb60f03b72df23",
  },
  {
    id: "bzip2",
    version: "1.0.8",
    url: "https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz",
    sha256: "ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269",
  },
  {
    id: "zstd",
    version: "1.5.6",
    url: "https://codeload.github.com/facebook/zstd/tar.gz/794ea1b0afca0f020f4e57b6732332231fb23c70",
    sha256: "33eaa5611d330dbc037e32554521d4e4a8edf2358df7d9b74d586c510a4bcec6",
  },
  {
    id: "brotli",
    version: "1.1.0",
    url: "https://codeload.github.com/google/brotli/tar.gz/ed738e842d2fbdf2d6459e39267a633c4a9b2f5d",
    sha256: "aaa739962a45b508b2e783b915e6b2b57ed3b12bd4b0feac73acfb144dffa54f",
  },
]);

const UGREP_ARCHIVE_FEATURES = "-z:zlib,bzip2,zstd,brotli,7z,tar/pax/cpio/zip";

const NATIVE_SEARCH_RUNTIME_TOOL_IDS_BY_PLATFORM = Object.freeze({
  darwin: Object.freeze(["bfs", "ugrep", "ripgrep"]),
  linux: Object.freeze(["bfs", "ugrep", "ripgrep"]),
  win32: Object.freeze(["ugrep", "ripgrep"]),
});

const NATIVE_SEARCH_PRODUCER_OUTPUT_IDS_BY_TARGET = Object.freeze({
  "darwin-arm64": Object.freeze(["bfs", "ugrep"]),
  "darwin-x64": Object.freeze(["bfs", "ugrep"]),
  "linux-arm64": Object.freeze(["bfs", "ugrep"]),
  "linux-x64": Object.freeze(["bfs", "ugrep"]),
  "win32-arm64": Object.freeze(["ugrep"]),
  "win32-x64": Object.freeze(["ugrep"]),
});

export const NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS = Object.freeze({
  "darwin-arm64": Object.freeze({
    archiveExt: "tar.gz",
    releaseFileName: "ripgrep-v14.1.1-1-aarch64-apple-darwin.tar.gz",
    revision: NATIVE_SEARCH_RIPGREP_REVISION,
    sha256: "84ff9b227b9aad651be0ac4cf7802a190015bfba3dfa6b015cc7aa89dd8c5c2b",
  }),
  "darwin-x64": Object.freeze({
    archiveExt: "tar.gz",
    releaseFileName: "ripgrep-v14.1.1-1-x86_64-apple-darwin.tar.gz",
    revision: NATIVE_SEARCH_RIPGREP_REVISION,
    sha256: "cfedd7993342bc5f90310ce73a00cbf5d3b5237654c9bfc18b383f0e829f3b11",
  }),
  "linux-arm64": Object.freeze({
    archiveExt: "tar.gz",
    releaseFileName: "ripgrep-v14.1.1-1-aarch64-unknown-linux-musl.tar.gz",
    revision: null,
    sha256: "98c0371366a9db920ed6c196083e8030511055e5f128b3bde2ca56bbddf85b9a",
  }),
  "linux-x64": Object.freeze({
    archiveExt: "tar.gz",
    releaseFileName: "ripgrep-v14.1.1-1-x86_64-unknown-linux-musl.tar.gz",
    revision: NATIVE_SEARCH_RIPGREP_REVISION,
    sha256: "1154dd91f7b144cee490b91f1ab27ce04f8f01d8876cde2d9c0eff845c8ab012",
  }),
  "win32-x64": Object.freeze({
    archiveExt: "zip",
    releaseFileName: "ripgrep-v14.1.1-1-x86_64-pc-windows-msvc.zip",
    revision: NATIVE_SEARCH_RIPGREP_REVISION,
    sha256: "ede1d7f533f30d7e2870f77139d0fb9d7591daad5260b80d6a525e0bb5bd440e",
  }),
  "win32-arm64": Object.freeze({
    archiveExt: "zip",
    releaseFileName: "ripgrep-v14.1.1-1-aarch64-pc-windows-msvc.zip",
    revision: NATIVE_SEARCH_RIPGREP_REVISION,
    sha256: "88660d96f822d2e0329e254031068e82028f9c13efcec9b2d78c5a19d3f9ac47",
  }),
});

export const NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET = Object.freeze({
  "darwin-arm64": Object.freeze({
    bfs: "696f73eaff50d3c3de8a8ee36746a89693dd6ff0d010b05cd3b4b3eb2a369781",
    ugrep: "01ea803e3fc3b94e796a9376e4d062a5490fe08e5760c6173e72b8f31546a4f3",
  }),
  "darwin-x64": Object.freeze({
    bfs: "d993d72530749fa777339a7546f03338499abf235e2147d4adcd086641c6376f",
    ugrep: "6a2bedd9ccf53a2ac574d2fa498a36dcbe21e957b40442f9493180c6dad4dea9",
  }),
  "linux-arm64": Object.freeze({
    bfs: "dabdde935a02f89dd0c48c5cd0ec756a87d300fd5ace85a78e6a9eb51d771118",
    ugrep: "bf3b99c0af41f50c0ec3031b32ab8f67fa95b5581add18fad5163ece978d31ba",
  }),
  "linux-x64": Object.freeze({
    bfs: "9adf5759000021dd8fcd99670461cc43863f9172fb16f2f9a3e49c700311e7a0",
    ugrep: "13732f50fe63da07f3472f627f611b75359153163d07a0eb01e7c54125ae930e",
  }),
  "win32-arm64": Object.freeze({
    ugrep: "e9de73f1b542105203d586b19b4d57b8ecf2bf780f23e86c66a0fb7f56d51024",
  }),
  "win32-x64": Object.freeze({
    ugrep: "7bbd8e56540d2019a343688f1fc0ddb2ff5f0988090c577d2b9d6f4a8a86be21",
  }),
});

const NATIVE_SEARCH_BINARY_NAMES = Object.freeze({
  bfs: "bfs",
  ripgrep: "rg",
  ugrep: "ugrep",
});

function resolveNativeSearchArchiveTarget(platform, arch) {
  switch (platform) {
    case "darwin":
      return `${arch === "arm64" ? "aarch64" : "x86_64"}-apple-darwin.tar.gz`;
    case "linux":
      return `${arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-gnu.tar.gz`;
    case "win32":
      return `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc.zip`;
  }
}

// 只有完成对应构建与发布校验的 platform key 才能进入 desktop 发行链路。
const ENABLED_NATIVE_SEARCH_PLATFORM_KEYS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "win32-arm64",
  "win32-x64",
]);
const UGREP_SOURCE_IDS = Object.freeze(["ugrep", "pcre2", "zlib", "bzip2", "zstd", "brotli"]);

export function normalizeNativeSearchPlatform(rawPlatform = process.platform) {
  switch (rawPlatform.toLowerCase()) {
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
      throw new Error(`unsupported native search platform ${rawPlatform}`);
  }
}

export function normalizeNativeSearchArch(rawArch = process.arch) {
  switch (rawArch.toLowerCase()) {
    case "x64":
    case "amd64":
    case "x86_64":
      return "x64";
    case "arm64":
    case "aarch64":
      return "arm64";
    default:
      throw new Error(`unsupported native search architecture ${rawArch}`);
  }
}

export function resolveNativeSearchPrebuiltRelease(toolId, rawPlatform = process.platform) {
  const platform = normalizeNativeSearchPlatform(rawPlatform);
  const release =
    NATIVE_SEARCH_PREBUILT_RELEASE_OVERRIDES[platform]?.[toolId] ??
    NATIVE_SEARCH_PREBUILT_RELEASES[toolId];
  if (!release) {
    throw new Error(`unsupported native search tool ${toolId}`);
  }
  return release;
}

export function isMacosRosettaTarget({
  platform,
  arch,
  hostPlatform = process.platform,
  hostArch = process.arch,
}) {
  return (
    normalizeNativeSearchPlatform(platform) === "darwin" &&
    normalizeNativeSearchPlatform(hostPlatform) === "darwin" &&
    normalizeNativeSearchArch(hostArch) === "arm64" &&
    normalizeNativeSearchArch(arch) === "x64"
  );
}

export function getNativeSearchRuntimeToolIdsForPlatform(rawPlatform) {
  const platform = normalizeNativeSearchPlatform(rawPlatform);
  return NATIVE_SEARCH_RUNTIME_TOOL_IDS_BY_PLATFORM[platform];
}

export function getNativeSearchProducerOutputIds({ platform, arch }) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  const platformKey = `${normalizedPlatform}-${normalizedArch}`;
  const outputIds = NATIVE_SEARCH_PRODUCER_OUTPUT_IDS_BY_TARGET[platformKey];
  if (!outputIds) {
    throw new Error(`unsupported native search producer target ${platformKey}`);
  }
  return outputIds;
}

export function getExpectedUgrepFeatureContract(rawPlatform) {
  const platform = normalizeNativeSearchPlatform(rawPlatform);
  const pcre2Feature = platform === "darwin" ? "-P:pcre2" : "-P:pcre2jit";
  return `; ${pcre2Feature}; ${UGREP_ARCHIVE_FEATURES}`;
}

export function resolveNativeSearchReleasePlan({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  const platformKey = `${normalizedPlatform}-${normalizedArch}`;
  const enabled = ENABLED_NATIVE_SEARCH_PLATFORM_KEYS.includes(platformKey);
  const runtimeToolIds = enabled
    ? [...getNativeSearchRuntimeToolIdsForPlatform(normalizedPlatform)]
    : [];

  return {
    platform: normalizedPlatform,
    arch: normalizedArch,
    platformKey,
    enabled,
    runtimeToolIds,
    extraResourceToolIds: runtimeToolIds.filter((toolId) => toolId !== "ripgrep"),
  };
}

export function getNativeSearchSourceArchivesForTarget({ platform, arch }) {
  const producerOutputIds = getNativeSearchProducerOutputIds({ platform, arch });
  const requiredSourceIds = new Set();
  if (producerOutputIds.includes("ugrep")) {
    for (const sourceId of UGREP_SOURCE_IDS) requiredSourceIds.add(sourceId);
  }
  if (producerOutputIds.includes("bfs")) {
    requiredSourceIds.add("bfs");
    requiredSourceIds.add("oniguruma");
  }
  return NATIVE_SEARCH_SOURCE_ARCHIVES.filter((source) => requiredSourceIds.has(source.id));
}

export function resolveNativeSearchBuildPlan({
  platform = process.platform,
  arch = process.arch,
  outputDir,
} = {}) {
  const normalizedPlatform = normalizeNativeSearchPlatform(platform);
  const normalizedArch = normalizeNativeSearchArch(arch);
  const platformKey = `${normalizedPlatform}-${normalizedArch}`;
  const resolvedOutputDir = resolve(
    outputDir ?? join(repoRoot, "packages/desktop/bundled-tools", platformKey),
  );
  const runtimeToolIds = getNativeSearchRuntimeToolIdsForPlatform(normalizedPlatform);
  const producerOutputIds = getNativeSearchProducerOutputIds({
    platform: normalizedPlatform,
    arch: normalizedArch,
  });
  const executableSuffix = normalizedPlatform === "win32" ? ".exe" : "";
  const binaries = Object.fromEntries(
    runtimeToolIds.map((toolId) => [
      toolId,
      join(resolvedOutputDir, toolId, `${NATIVE_SEARCH_BINARY_NAMES[toolId]}${executableSuffix}`),
    ]),
  );

  return {
    platform: normalizedPlatform,
    arch: normalizedArch,
    platformKey,
    outputDir: resolvedOutputDir,
    runtimeToolIds,
    producerOutputIds: [...producerOutputIds],
    binaries,
    bfsPath: binaries.bfs,
    rgPath: binaries.ripgrep,
    ugrepPath: binaries.ugrep,
  };
}

export function resolveNativeSearchPrebuiltPlan({
  platform = process.platform,
  arch = process.arch,
  outputDir,
  dependenciesDir = NATIVE_SEARCH_DEPENDENCIES_DIR,
} = {}) {
  const buildPlan = resolveNativeSearchBuildPlan({ platform, arch, outputDir });
  const archiveTarget = resolveNativeSearchArchiveTarget(buildPlan.platform, buildPlan.arch);
  const officialRipgrepAsset = NATIVE_SEARCH_OFFICIAL_RIPGREP_ASSETS[buildPlan.platformKey];

  return {
    ...buildPlan,
    artifacts: buildPlan.runtimeToolIds.map((toolId) => {
      if (toolId === "ripgrep") {
        if (!officialRipgrepAsset) {
          throw new Error(`missing Microsoft ripgrep asset for ${buildPlan.platformKey}`);
        }
        return {
          toolId,
          version: NATIVE_SEARCH_TOOL_VERSIONS[toolId],
          release: NATIVE_SEARCH_PREBUILT_RELEASES[toolId],
          releaseFileName: officialRipgrepAsset.releaseFileName,
          archiveExt: officialRipgrepAsset.archiveExt,
          archiveSha256: officialRipgrepAsset.sha256,
          binaryName: `${NATIVE_SEARCH_BINARY_NAMES[toolId]}${buildPlan.platform === "win32" ? ".exe" : ""}`,
          binaryPath: buildPlan.binaries[toolId],
          archivePath: resolve(
            dependenciesDir,
            `ripgrep-${NATIVE_SEARCH_PREBUILT_RELEASES.ripgrep}`,
            officialRipgrepAsset.releaseFileName,
          ),
          source: "official",
        };
      }

      const release = resolveNativeSearchPrebuiltRelease(toolId, buildPlan.platform);
      const releaseFileName = `${toolId}-${release}-${archiveTarget}`;
      const archiveSha256 =
        NATIVE_SEARCH_PRODUCER_ARCHIVE_SHA256_BY_TARGET[buildPlan.platformKey]?.[toolId];
      if (!archiveSha256) {
        throw new Error(
          `missing producer archive SHA-256 for ${buildPlan.platformKey}/${releaseFileName}`,
        );
      }
      return {
        toolId,
        version: NATIVE_SEARCH_TOOL_VERSIONS[toolId],
        release,
        releaseFileName,
        archiveExt: archiveTarget.endsWith(".zip") ? "zip" : "tar.gz",
        archiveSha256,
        binaryName: `${NATIVE_SEARCH_BINARY_NAMES[toolId]}${buildPlan.platform === "win32" ? ".exe" : ""}`,
        binaryPath: buildPlan.binaries[toolId],
        archivePath: resolve(dependenciesDir, `${toolId}-${release}`, releaseFileName),
        source: "producer",
      };
    }),
  };
}
