import type { ExecutionEnvOverlay, ExecutionPort, ExecutionRequest } from "@lcode/contracts";

export interface ProjectEnvironmentOverlayResolver {
  (cwd: string | undefined): Promise<ExecutionEnvOverlay | undefined>;
  /** 实际执行 owner 关闭成功后才能结算引用。 */
  close?: () => Promise<void>;
}
const protectedKeys = new Set([
  "PATH", "TEMP", "TMP", "TMPDIR", "LCODE_DATA_BASE_DIR", "LCODE_ENVIRONMENT_ID",
  "LCODE_ENVIRONMENT_REVISION", "NPM_CONFIG_PACKAGE_IMPORT_METHOD", "NPM_CONFIG_STORE_DIR",
]);
const canonicalKey = (key: string, platform: NodeJS.Platform) =>
  platform === "win32" ? key.toUpperCase() : key;

/** Hook 变量保留；托管 PATH/资源映射不能被请求 overlay 清除或替换。 */
export function mergeProjectEnvOverlay(
  request: ExecutionRequest,
  frozen: ExecutionEnvOverlay,
  platform: NodeJS.Platform = process.platform,
): ExecutionRequest {
  const own = request.env;
  if (own?.base === "empty" && frozen.base !== "empty")
    throw new Error("Managed execution cannot discard its frozen environment");
  const ownerKeys = new Map(Object.entries(frozen.set ?? {}).map(([key, value]) =>
    [canonicalKey(key, platform), { key, value }]));
  for (const [key, value] of Object.entries(own?.set ?? {})) {
    const owner = ownerKeys.get(canonicalKey(key, platform));
    if (owner && protectedKeys.has(owner.key.toUpperCase()) && owner.value !== value)
      throw new Error(`Managed execution cannot override ${owner.key}`);
  }
  for (const key of own?.unset ?? []) {
    const owner = ownerKeys.get(canonicalKey(key, platform));
    if (owner && protectedKeys.has(owner.key.toUpperCase()))
      throw new Error(`Managed execution cannot remove ${owner.key}`);
  }
  const set: Record<string, string> = { ...frozen.set };
  for (const [key, value] of Object.entries(own?.set ?? {})) {
    for (const existing of Object.keys(set))
      if (canonicalKey(existing, platform) === canonicalKey(key, platform)) delete set[existing];
    set[key] = value;
  }
  const unset = [...new Set([...(frozen.unset ?? []), ...(own?.unset ?? [])])];
  return { ...request, env: {
    base: own?.base ?? frozen.base ?? "inherit",
    ...(Object.keys(set).length ? { set } : {}), ...(unset.length ? { unset } : {}),
  } };
}

export function createProjectScopedExecutionPort(
  base: ExecutionPort,
  resolve: ProjectEnvironmentOverlayResolver,
): ExecutionPort {
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const preparing = new Set<Promise<ExecutionRequest>>();
  const prepare = (request: ExecutionRequest) => {
    if (closing) return Promise.reject(new Error("Execution port is closing"));
    const pending = (async () => {
      const frozen = await resolve(request.cwd);
      if (closing) throw new Error("Execution port closed before spawn");
      return frozen ? mergeProjectEnvOverlay(request, frozen) : request;
    })();
    preparing.add(pending);
    return pending.finally(() => preparing.delete(pending));
  };
  const port: ExecutionPort = {
    async run(request, options) {
      options?.signal?.throwIfAborted();
      const resolved = await prepare(request);
      options?.signal?.throwIfAborted();
      if (closing) throw new Error("Execution port closed before spawn");
      return base.run(resolved, options);
    },
    close() {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        await Promise.allSettled(preparing);
        if (!base.close) throw new Error("Execution owner cannot confirm shutdown");
        await base.close();
        await resolve.close?.();
      })();
      return closePromise;
    },
  };
  if (base.start) port.start = async (request, options) => {
    options?.signal?.throwIfAborted();
    const resolved = await prepare(request);
    options?.signal?.throwIfAborted();
    if (closing) throw new Error("Execution port closed before spawn");
    return base.start!(resolved, options);
  };
  if (base.getBackgroundTask) port.getBackgroundTask = (id) => base.getBackgroundTask!(id);
  if (base.waitForBackgroundTask) port.waitForBackgroundTask = (id, options) => base.waitForBackgroundTask!(id, options);
  if (base.readBackgroundBashOutput) port.readBackgroundBashOutput = (id, sessionId) => base.readBackgroundBashOutput!(id, sessionId);
  if (base.cancelBackgroundTask) port.cancelBackgroundTask = (id) => base.cancelBackgroundTask!(id);
  return port;
}
