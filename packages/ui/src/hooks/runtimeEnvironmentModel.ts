import {
  runtimeEnvironmentSnapshotSchema,
  type RuntimeEnvironmentAction,
  type RuntimeEnvironmentCapabilities,
  type RuntimeEnvironmentScope,
  type RuntimeEnvironmentSnapshot,
} from "@lcode/shared";

export function environmentScopeKey(scope: RuntimeEnvironmentScope) {
  return JSON.stringify([
    scope.workspaceIdentity?.trim() || scope.workspacePath,
    scope.workspacePath,
  ]);
}

/** checkout 路径不能被 identity 去重吞掉；同一远端项目也可同时展示工作树和候选环境。 */
export function applyEnvironmentSnapshot(
  current: RuntimeEnvironmentSnapshot | null,
  incoming: unknown,
  scope: RuntimeEnvironmentScope,
  environmentId: string,
): RuntimeEnvironmentSnapshot | null {
  const parsed = runtimeEnvironmentSnapshotSchema.safeParse(incoming);
  if (!parsed.success) return current;
  const next = parsed.data;
  if (environmentScopeKey(next.scope) !== environmentScopeKey(scope)) return current;
  if (next.environment && next.environment.environmentId !== environmentId) return current;
  // 同 identity 的慢查询也可能晚于服务事件返回；按 owner 版本，而不是请求完成时间结算。
  if (current && next.stateRevision < current.stateRevision) return current;
  return next;
}

export function environmentActionAvailable(
  capabilities: RuntimeEnvironmentCapabilities | undefined,
  action: RuntimeEnvironmentAction,
) {
  return (
    capabilities?.managedEnvironments === true &&
    capabilities.protocolVersion === 1 &&
    capabilities.actions?.includes(action) === true
  );
}

export function environmentPreviewAvailability(
  value: string,
  isDesktop: boolean,
  isRemoteTarget: boolean,
): "invalid-url" | "host-unreachable" | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "invalid-url";
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    return "invalid-url";
  const hostname = url.hostname.toLowerCase();
  if (["0.0.0.0", "[::]"].includes(hostname)) return "host-unreachable";
  const loopback =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    hostname.startsWith("127.");
  // openExternal 在 Web 打开的是当前设备浏览器；它不是到宿主的端口代理。
  return loopback && (!isDesktop || isRemoteTarget) ? "host-unreachable" : null;
}
