import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { LCODE_VERSION } from "@lcode/shared";
import type { IRemoteBackend } from "@lcode/server/remote/backend.js";
import type { RemoteEnvironment } from "@lcode/server/remote/backend.js";
import {
  REMOTE_BASE,
  type DeployLoggers,
  waitForClose,
} from "@lcode/server/remote/deployShared.js";
import {
  buildWriteLiteralFileCommand,
  quotePosixPathArg,
} from "@lcode/server/remote/posixShell.js";
import {
  fetchRemoteAssetManifestRefFromCdn,
  type RemoteAssetManifest,
  type RemoteAssetManifestRef,
} from "@lcode/server/remote/remoteAssetCache.js";
import {
  buildReleaseBaseCandidates,
  resolveRemoteCdnBaseUrls,
} from "@lcode/server/remote/remoteAssetCdn.js";
import type { RemoteAssetNetworkPort } from "@lcode/server/remote/remoteAssetNetwork.js";

const REMOTE_ASSET_COMPONENT_META_DIR = `${REMOTE_BASE}/.asset-components`;

export interface RemoteAssetIdentityResolverOptions {
  mockCdnDir?: string;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export function createFreshRemoteAssetManifestRefResolver(
  options: RemoteAssetIdentityResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): () => Promise<RemoteAssetManifestRef | null> {
  let manifestPromise: Promise<RemoteAssetManifestRef | null> | null = null;
  return () => {
    manifestPromise ??= resolveFreshComponentManifest(options, env, loggers);
    return manifestPromise;
  };
}

export interface RemoteAssetComponentIdentity {
  sha256: string;
}

export interface RemoteAssetComponentMeta {
  id: string;
  version?: string;
  sha256?: string;
  pendingRefreshAppVersion?: string;
  platformArch: string;
}

export type RemoteAssetComponentIdentityDecision =
  | { shouldDeploy: false }
  | { shouldDeploy: true; reason: string };

export async function checkRemoteAssetComponentIdentity(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    expectedIdentity: RemoteAssetComponentIdentity;
  },
): Promise<RemoteAssetComponentIdentityDecision> {
  const remoteMeta = await readRemoteAssetComponentMeta(backend, options.componentId);
  if (!remoteMeta) {
    return {
      shouldDeploy: true,
      reason: `remote component meta missing expected=${formatIdentity(options.expectedIdentity)}`,
    };
  }
  if (remoteMeta.id !== options.componentId) {
    return {
      shouldDeploy: true,
      reason: `remote component id mismatch remote=${remoteMeta.id} expected=${options.componentId}`,
    };
  }
  if (remoteMeta.platformArch !== options.platformArch) {
    return {
      shouldDeploy: true,
      reason: `remote platform mismatch remote=${remoteMeta.platformArch} expected=${options.platformArch}`,
    };
  }
  if (!remoteMeta.sha256) {
    // 旧 live marker 只记录 version，无法证明运行目录来自当前 manifest 制品。
    // 首次读取旧 marker 时必须重新部署并写入 SHA，不能继续按语义版本跳过。
    return {
      shouldDeploy: true,
      reason: `remote component SHA missing expected=${options.expectedIdentity.sha256}`,
    };
  }
  if (
    remoteMeta.sha256.trim().toLowerCase() !== options.expectedIdentity.sha256.trim().toLowerCase()
  ) {
    return {
      shouldDeploy: true,
      reason: `remote SHA mismatch remote=${remoteMeta.sha256} expected=${options.expectedIdentity.sha256}`,
    };
  }

  return { shouldDeploy: false };
}

export async function readRemoteAssetComponentMeta(
  backend: IRemoteBackend,
  componentId: string,
): Promise<RemoteAssetComponentMeta | null> {
  try {
    const content = await backend.readFile(buildRemoteAssetComponentMetaPath(componentId));
    const parsed = JSON.parse(content) as Partial<RemoteAssetComponentMeta>;
    if (
      typeof parsed.id !== "string" ||
      typeof parsed.platformArch !== "string" ||
      (parsed.version !== undefined && typeof parsed.version !== "string") ||
      (parsed.sha256 !== undefined && typeof parsed.sha256 !== "string") ||
      (parsed.pendingRefreshAppVersion !== undefined &&
        typeof parsed.pendingRefreshAppVersion !== "string")
    ) {
      return null;
    }
    return {
      id: parsed.id,
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.sha256 ? { sha256: parsed.sha256 } : {}),
      ...(parsed.pendingRefreshAppVersion
        ? { pendingRefreshAppVersion: parsed.pendingRefreshAppVersion }
        : {}),
      platformArch: parsed.platformArch,
    };
  } catch {
    return null;
  }
}

export async function writeRemoteAssetComponentMeta(
  backend: IRemoteBackend,
  meta: RemoteAssetComponentMeta,
): Promise<void> {
  // 其它资源包保持既有语义：无法解析版本时不写一个会永久失配的 unknown marker。
  if (meta.version === "unknown" && !meta.sha256) {
    return;
  }
  const stream = await backend.exec(
    [
      `mkdir -p ${quotePosixPathArg(REMOTE_ASSET_COMPONENT_META_DIR)}`,
      buildWriteLiteralFileCommand(
        buildRemoteAssetComponentMetaPath(meta.id),
        `${JSON.stringify(meta)}\n`,
      ),
    ].join(" && "),
  );
  await waitForClose(stream);
}

export async function markRemoteAssetComponentRefreshPending(
  backend: IRemoteBackend,
  options: {
    componentId: string;
    platformArch: string;
    appVersion: string;
  },
): Promise<void> {
  await writeRemoteAssetComponentMeta(backend, {
    id: options.componentId,
    platformArch: options.platformArch,
    pendingRefreshAppVersion: options.appVersion,
  });
}

export async function hasRemoteAssetComponentRefreshPending(
  backend: IRemoteBackend,
  options: { componentId: string; platformArch: string },
): Promise<boolean> {
  const meta = await readRemoteAssetComponentMeta(backend, options.componentId);
  return Boolean(
    meta &&
    meta.id === options.componentId &&
    meta.platformArch === options.platformArch &&
    meta.pendingRefreshAppVersion,
  );
}

function buildRemoteAssetComponentMetaPath(componentId: string): string {
  return `${REMOTE_ASSET_COMPONENT_META_DIR}/${componentId}.json`;
}

function formatIdentity(identity: RemoteAssetComponentIdentity): string {
  return identity.sha256;
}

async function resolveFreshComponentManifest(
  options: RemoteAssetIdentityResolverOptions,
  env: RemoteEnvironment,
  loggers: DeployLoggers,
): Promise<RemoteAssetManifestRef | null> {
  const platformArch = `${env.platform}-${env.arch}`;
  if (options.mockCdnDir) {
    try {
      const content = await readFile(
        join(options.mockCdnDir, "releases", LCODE_VERSION, `manifest-${platformArch}.json`),
        "utf8",
      );
      return {
        manifest: JSON.parse(content) as RemoteAssetManifest,
        releaseBaseCandidatesForComponents: buildReleaseBaseCandidates(
          resolveRemoteCdnBaseUrls(options),
          LCODE_VERSION,
        ),
      };
    } catch (error) {
      loggers.logWarn(
        `[remote-assets] mock component manifest unavailable, fallback to release checks: ${String(error)}`,
      );
      return null;
    }
  }

  try {
    const manifestRef = await fetchRemoteAssetManifestRefFromCdn(
      {
        remoteCdnBaseUrl: options.remoteCdnBaseUrl,
        remoteCdnBaseUrls: options.remoteCdnBaseUrls,
        remoteCacheDir: options.remoteCacheDir,
        version: LCODE_VERSION,
        platformArch,
        manifestRequestTimeoutMs: options.manifestRequestTimeoutMs,
        remoteAssetNetwork: options.remoteAssetNetwork,
        // server-bundle/GLM 允许在 app/version 不变时重发制品，每次部署必须重新取
        // manifest，不能复用进程内旧 SHA；promise 保证本次部署只刷新一次。
        refreshManifest: true,
      },
      loggers,
    );
    const hasConfiguredManifestSource =
      Boolean(options.remoteCacheDir?.trim()) &&
      (Boolean(options.remoteCdnBaseUrl?.trim()) ||
        Boolean(options.remoteCdnBaseUrls?.some((baseUrl) => baseUrl.trim().length > 0)));
    if (!manifestRef && hasConfiguredManifestSource) {
      // server-bundle 的身份判断与安装必须来自同一 manifest；404 后
      // 不能继续走 installer 再请求一次，否则发布切换时可能部署另一份制品。
      throw new Error(
        `[remote-assets] manifest not found for ${platformArch}: manifest-${platformArch}.json`,
      );
    }
    return manifestRef;
  } catch (error) {
    loggers.logWarn(`[remote-assets] component manifest request failed: ${String(error)}`);
    // 这是内容寻址组件在本次 deploy transaction 的 pinned identity 输入。网络超时/解析失败
    // 不能降级为“manifest 缺失”后再请求一次，否则会丢失原始诊断并翻倍 deadline。
    throw error;
  }
}
