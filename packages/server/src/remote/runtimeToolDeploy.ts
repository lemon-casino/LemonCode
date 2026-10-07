import { getRemoteRuntimeToolsForPlatform, type RemoteResourcePackageId } from "@lcode/shared";
import type { IRemoteBackend, RemoteEnvironment } from "@lcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  buildRemoteChmodExecutableCommand,
  type DeployLoggers,
  type RemoteAssetDeployOptions,
  waitForClose,
} from "@lcode/server/remote/deployShared.js";
import type { RemoteAssetInstaller } from "@lcode/server/remote/remoteAssetInstaller.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
  quotePosixShellArg,
} from "@lcode/server/remote/posixShell.js";
import {
  checkRemoteAssetComponentIdentity,
  writeRemoteAssetComponentMeta,
} from "@lcode/server/remote/remoteAssetLiveIdentity.js";

const REMOTE_TOOLS_BASE = `${REMOTE_BASE}/tools`;
const MISE_VERSION = "v2026.10.2";
const MISE_REQUIRED_PATHS = ["bin/mise", "LICENSE", "README.md", "backend-manifest.json"];

/** mise 是环境后端 component，不是可裁剪的 Agent 搜索工具。 */
export async function deployMiseRuntime(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployRuntimeToolOptions,
  loggers: DeployLoggers,
): Promise<void> {
  const remoteDir = `${REMOTE_TOOLS_BASE}/mise`;
  try {
    options.signal?.throwIfAborted();
    if (
      !["linux", "darwin"].includes(env.platform) ||
      !["x64", "arm64"].includes(env.arch) ||
      options.platformArch !== `${env.platform}-${env.arch}`
    ) {
      throw new Error(`unsupported remote platform ${env.platform}-${env.arch}`);
    }
    // 旧 release 没有 mise 时必须拒绝连接，不能靠远端 PATH 或临时安装补一个后端。
    const sha256 = await options.installer.resolveComponentSha256?.("mise");
    if (!sha256 || !/^[a-f0-9]{64}$/u.test(sha256)) {
      throw new Error("required release component mise SHA is missing");
    }
    const identity = await checkRemoteAssetComponentIdentity(backend, {
      componentId: "mise",
      platformArch: options.platformArch,
      expectedIdentity: { sha256 },
    });
    let needsInstall = identity.shouldDeploy;
    for (const member of MISE_REQUIRED_PATHS) {
      if (!(await backend.exists(`${remoteDir}/${member}`))) needsInstall = true;
    }
    if (needsInstall) {
      options.signal?.throwIfAborted();
      await options.installer.installDirectory({
        componentId: "mise",
        sourceRelativePath: `tools/${options.platformArch}/mise`,
        remoteDir,
        requiredRelativePaths: MISE_REQUIRED_PATHS,
      });
    }
    options.signal?.throwIfAborted();
    // 身份 marker 只证明制品来源，不证明当前文件仍完整；每次连接都验证实际固定路径。
    await verifyRemoteMise(
      backend,
      remoteDir,
      `${env.platform === "darwin" ? "macos" : "linux"}-${env.arch}`,
    );
    options.signal?.throwIfAborted();
    if (needsInstall) {
      await writeRemoteAssetComponentMeta(backend, {
        id: "mise",
        version: MISE_VERSION,
        sha256,
        platformArch: options.platformArch,
      });
    }
    loggers.log(`[runtime-deploy] mise: ${MISE_VERSION} verified at ${remoteDir}`);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error(
      `capability-unavailable: bundled mise for ${options.platformArch} is missing or invalid: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function verifyRemoteMise(
  backend: IRemoteBackend,
  remoteDir: string,
  platform: string,
): Promise<void> {
  // 复用已部署的固定 Node 校验 manifest 和大二进制的流式 SHA，不借 shell 上的 node/mise。
  // 官方归档摘要由构建唯一 validator 固定；此处保留 release SHA → manifest → binary 的信任链。
  const verifier = [
    'const fs = require("node:fs/promises"), crypto = require("node:crypto"), path = require("node:path");',
    "(async () => { const root = process.argv[1];",
    'if (!(await fs.lstat(root)).isDirectory() || !(await fs.lstat(path.join(root, "bin"))).isDirectory()) throw new Error("mise root/bin must be regular directories");',
    `for (const member of ${JSON.stringify(MISE_REQUIRED_PATHS)}) { if (!(await fs.lstat(path.join(root, member))).isFile()) throw new Error("mise member is not a regular file: " + member); }`,
    'const manifest = JSON.parse(await fs.readFile(path.join(root, "backend-manifest.json"), "utf8"));',
    `if (manifest.version !== ${JSON.stringify(MISE_VERSION)} || manifest.platform !== ${JSON.stringify(platform)}) throw new Error("mise manifest version/platform mismatch");`,
    'if (!/^[a-f0-9]{64}$/.test(manifest.archiveSha256) || !/^[a-f0-9]{64}$/.test(manifest.binarySha256)) throw new Error("mise manifest digest invalid");',
    'const file = await fs.open(path.join(root, "bin/mise"), "r"), hash = crypto.createHash("sha256");',
    "try { for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk); } finally { await file.close(); }",
    'if (hash.digest("hex") !== manifest.binarySha256) throw new Error("mise binary digest mismatch");',
    "})().catch(error => { process.stderr.write(error.message); process.exitCode = 1; });",
  ].join("\n");
  const binaryPath = `${remoteDir}/bin/mise`;
  const expectedVersionPrefix = `${MISE_VERSION.slice(1)} ${platform}`;
  const command = [
    "set -eu",
    `${quotePosixPathArg(`${REMOTE_BASE}/node`)} -e ${quotePosixShellArg(verifier)} ${quotePosixPathArg(remoteDir)}`,
    buildRemoteChmodExecutableCommand(binaryPath),
    `mise_version=$(MISE_NO_CONFIG=1 MISE_AUTO_INSTALL=0 ${quotePosixPathArg(binaryPath)} --no-config --version)`,
    `case "$mise_version" in ${quotePosixShellArg(expectedVersionPrefix)}|${quotePosixShellArg(`${expectedVersionPrefix} `)}*) ;; *) printf '%s\\n' 'mise binary version/platform mismatch' >&2; exit 1 ;; esac`,
  ].join("\n");
  await waitForClose(await backend.exec(command));
}

export interface DeployRuntimeToolOptions extends RemoteAssetDeployOptions {
  platformArch: string;
  installer: RemoteAssetInstaller;
  selectedResourcePackageIds?: RemoteResourcePackageId[];
}

export async function deployRuntimeTools(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options: DeployRuntimeToolOptions,
  loggers: DeployLoggers,
): Promise<void> {
  await deployMiseRuntime(backend, env, options, loggers);
  const platformArch = options.platformArch;

  for (const { toolId, runtime, version } of getRemoteRuntimeToolsForPlatform(env.platform)) {
    const componentId = runtime.bundledResourceDir as RemoteResourcePackageId;
    if (
      options.selectedResourcePackageIds &&
      !options.selectedResourcePackageIds.includes(componentId)
    ) {
      loggers.log(`[tool-deploy] ${toolId}: 未选择资源包 ${componentId}，跳过检查和部署`);
      continue;
    }

    const entrySegments = runtime.resolveEntrySegments(env.platform);
    const binaryName = entrySegments[entrySegments.length - 1];
    if (!binaryName) {
      loggers.logWarn(`[tool-deploy] ${toolId}: 无法解析 binary 名称，跳过部署`);
      continue;
    }

    const remoteToolDir = `${REMOTE_TOOLS_BASE}/${runtime.bundledResourceDir}`;
    const remoteVersionFile = `${remoteToolDir}/.version`;
    const remoteBinaryPath = `${remoteToolDir}/${binaryName}`;

    let remoteVersion = "";
    try {
      remoteVersion = (await backend.readFile(remoteVersionFile)).trim();
    } catch {
      remoteVersion = "";
    }

    if (remoteVersion === version) {
      const hasRemoteBinary = await backend.exists(remoteBinaryPath);
      if (hasRemoteBinary) {
        loggers.log(`[tool-deploy] ${toolId}: 远程版本 ${version} 已是最新，跳过`);
        continue;
      }
      loggers.logWarn(
        `[remote-assets] ${options.installer.mode === "remote-download" ? "download required" : "upload required"}: component=${runtime.bundledResourceDir} reason=remote binary missing path=${remoteBinaryPath}`,
      );
    }

    loggers.log(`[tool-deploy] ${toolId}: 开始部署 ${version}`);
    await options.installer.installFile({
      componentId,
      sourceRelativePath: `tools/${platformArch}/${runtime.bundledResourceDir}/${binaryName}`,
      remotePath: remoteBinaryPath,
      executable: true,
    });

    const versionStream = await backend.exec(
      buildWriteLiteralFileCommand(remoteVersionFile, version),
    );
    await waitForClose(versionStream);
    loggers.log(`[tool-deploy] ${toolId}: 部署完成 ${version}`);
  }
}
