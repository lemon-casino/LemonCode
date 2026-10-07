import { randomUUID } from "node:crypto";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { LCODE_PLUGIN_HOST_COMMAND } from "@lcode/contracts";
import type {
  ExecutionEnvOverlay,
  McpConnectOptions,
  McpPort,
  McpServerConfig,
  McpStdioServerConfig,
} from "@lcode/contracts";
import type { ProjectEnvironmentOverlayResolver } from "./project-environment-execution.js";

/** Session 并行关闭 owner；单个 execution.close 不能提前释放 MCP 共用的 consumer。 */
export function createProjectEnvironmentCloseBarrier<Owner extends string>(
  resolver: ProjectEnvironmentOverlayResolver,
  owners: readonly Owner[],
): Record<Owner, ProjectEnvironmentOverlayResolver> {
  const remaining = new Set(owners);
  let release: Promise<void> | undefined;
  return Object.fromEntries(
    owners.map((owner) => {
      const scoped: ProjectEnvironmentOverlayResolver = (cwd) => {
        if (!remaining.has(owner)) return Promise.reject(new Error("Environment owner is closed"));
        return resolver(cwd);
      };
      scoped.close = () => {
        if (remaining.delete(owner) && remaining.size === 0) {
          release = Promise.resolve().then(() => resolver.close?.());
        }
        return release ?? Promise.resolve();
      };
      return [owner, scoped];
    }),
  ) as Record<Owner, ProjectEnvironmentOverlayResolver>;
}

interface ProjectMcpOptions {
  workingDirectory?: string;
  environmentRef?: McpConnectOptions["environmentRef"];
  platform?: NodeJS.Platform;
}

const canonicalKey = (key: string, platform: NodeJS.Platform) =>
  platform === "win32" ? key.toUpperCase() : key;

function snapshotOverlay(
  overlay: ExecutionEnvOverlay,
  platform: NodeJS.Platform,
): ExecutionEnvOverlay {
  return {
    base: overlay.base ?? "inherit",
    set: Object.fromEntries(
      Object.entries(overlay.set ?? {}).map(([key, value]) => [canonicalKey(key, platform), value]),
    ),
    unset: [...new Set((overlay.unset ?? []).map((key) => canonicalKey(key, platform)))].sort(),
  };
}

function mergeConfigEnv(
  config: McpStdioServerConfig,
  frozen: ExecutionEnvOverlay,
  platform: NodeJS.Platform,
) {
  const env: Record<string, string> = {};
  const unset = new Set(frozen.unset);
  for (const [key, value] of Object.entries(config.env ?? {})) {
    const canonical = canonicalKey(key, platform);
    if (unset.has(canonical)) throw new Error(`MCP cannot restore frozen removed variable ${key}`);
    if (Object.hasOwn(frozen.set ?? {}, canonical) && frozen.set![canonical] !== value)
      throw new Error(`MCP cannot override frozen variable ${key}`);
    env[canonical] = value;
  }
  return { ...env, ...frozen.set };
}

function isApplicationRuntime(config: McpStdioServerConfig): boolean {
  // 固定绝对路径的应用 Helper Node 不属于项目工具；普通 command:"node" 必须走冻结 PATH。
  return (
    isAbsolute(config.command) &&
    (config.source?.kind === "builtin" ||
      (config.command === process.execPath &&
        config.args?.includes(LCODE_PLUGIN_HOST_COMMAND) === true))
  );
}

/** 装饰真实端口/既有 pool lease；冻结配置一直保留到 probe sibling 和断连重建。 */
export function createProjectScopedMcpPort(
  base: McpPort,
  resolver: ProjectEnvironmentOverlayResolver,
  options: ProjectMcpOptions = {},
): McpPort {
  const ownerId = randomUUID();
  const platform = options.platform ?? process.platform;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let closeFailure: Error | undefined;
  const preparing = new Set<Promise<unknown>>();
  const assertOpen = () => {
    if (closing) throw new Error("MCP environment owner is closing");
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    preparing.add(operation);
    return operation.finally(() => preparing.delete(operation));
  };
  const resolve = (cwd: string) =>
    track(
      (async () => {
        assertOpen();
        const overlay = await resolver(cwd);
        assertOpen();
        return overlay ? snapshotOverlay(overlay, platform) : undefined;
      })(),
    );
  const prepare = async (
    config: McpServerConfig,
    connectOptions?: McpConnectOptions,
  ): Promise<McpServerConfig> => {
    assertOpen();
    connectOptions?.signal?.throwIfAborted();
    if (config.type !== "stdio" || config.enabled === false || isApplicationRuntime(config))
      return config;
    const cwd = resolvePath(
      connectOptions?.workingDirectory ?? options.workingDirectory ?? process.cwd(),
      config.cwd ?? "",
    );
    const overlay = await resolve(cwd);
    connectOptions?.signal?.throwIfAborted();
    const environmentRef = options.environmentRef ?? connectOptions?.environmentRef;
    if (!overlay) {
      if (environmentRef) throw new Error("Managed MCP is missing its frozen environment");
      return config;
    }
    if (
      options.environmentRef &&
      connectOptions?.environmentRef &&
      (options.environmentRef.environmentId !== connectOptions.environmentRef.environmentId ||
        options.environmentRef.revision !== connectOptions.environmentRef.revision ||
        (connectOptions.environmentRef.manifestDigest !== undefined &&
          options.environmentRef.manifestDigest !== connectOptions.environmentRef.manifestDigest))
    )
      throw new Error("stale-reference: MCP environment differs from its app binding");
    return {
      ...config,
      cwd,
      env: mergeConfigEnv(config, overlay, platform),
      projectEnvironment: {
        ownerId,
        ...(environmentRef ? { environmentRef: { ...environmentRef } } : {}),
        overlay,
        async authorizeSpawn() {
          // 旧实现仅把 ref 放进 key，探测/重连仍可能使用宿主 PATH；每次 spawn 都重新受 Host fence 约束。
          if (!isDeepStrictEqual(await resolve(cwd), overlay))
            throw new Error("stale-reference: MCP frozen environment changed before spawn");
        },
        reportCloseFailure(error) {
          closeFailure ??=
            error instanceof Error
              ? error
              : new Error("MCP process exit unconfirmed", { cause: error });
        },
      },
    };
  };
  const port: McpPort = {
    async connectServer(name, config, connectOptions) {
      const prepared = await prepare(config, connectOptions);
      assertOpen();
      connectOptions?.signal?.throwIfAborted();
      return base.connectServer(name, prepared, connectOptions);
    },
    async connectConfiguredServers(servers, connectOptions) {
      assertOpen();
      connectOptions?.signal?.throwIfAborted();
      const prepared = Object.fromEntries(
        await Promise.all(
          Object.entries(servers).map(
            async ([name, config]) => [name, await prepare(config, connectOptions)] as const,
          ),
        ),
      );
      assertOpen();
      connectOptions?.signal?.throwIfAborted();
      return base.connectConfiguredServers(prepared, connectOptions);
    },
    disconnectServer: (name) => base.disconnectServer(name),
    status: () => base.status(),
    listTools: () => base.listTools(),
    async callTool(request, callOptions) {
      assertOpen();
      return base.callTool(request, callOptions);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await Promise.allSettled(preparing);
        if (typeof base.close !== "function") throw new Error("MCP owner cannot confirm shutdown");
        await base.close();
        if (closeFailure) throw closeFailure;
        await resolver.close?.();
      })();
      return closePromise;
    },
  };
  if (base.pingServer) port.pingServer = (name, pingOptions) => base.pingServer!(name, pingOptions);
  return port;
}
