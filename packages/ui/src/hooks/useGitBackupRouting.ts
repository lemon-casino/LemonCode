import { useMemo } from "react";
import type { IGitBackupService } from "@lcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";

export interface GitBackupSectionTarget {
  workspacePath?: string | null;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

export function resolveGitBackupConnectionKind(
  target: GitBackupSectionTarget,
  resolved: "local-ready" | "remote-ready" | "remote-waiting",
): "local-ready" | "remote-ready" | "remote-waiting" {
  // 仅有 remoteTarget 的恢复阶段也属于远端；路由未就绪时绝不能读取本机凭据或服务。
  const remote = Boolean(
    target.workspaceIdentity?.trim() || target.remoteSessionId?.trim() || target.remoteTarget,
  );
  return remote && resolved === "local-ready" ? "remote-waiting" : resolved;
}

const hostIds = new WeakMap<object, number>();
let nextHostId = 0;

export function useGitBackupRouting(target: GitBackupSectionTarget) {
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId,
    target.workspaceIdentity,
    target.remoteTarget,
  );
  const connectionKind = resolveGitBackupConnectionKind(target, resolution.connectionKind);
  const service: IGitBackupService | null = useMemo(
    () =>
      connectionKind !== "remote-waiting" && resolution.rpcReady
        ? (resolution.services.gitBackupService ?? null)
        : null,
    [connectionKind, resolution.rpcReady, resolution.services],
  );
  const host = service ?? resolution.services;
  let hostId = hostIds.get(host);
  if (hostId === undefined) {
    hostId = ++nextHostId;
    hostIds.set(host, hostId);
  }
  const workspacePath = target.workspacePath?.trim() || null;
  const workspaceIdentity = target.workspaceIdentity?.trim() || undefined;
  return {
    service,
    connectionKind,
    // 同一路径可能同时属于本机与远端，必须同时隔离 identity、attachment 和服务实例。
    controllerKey: JSON.stringify([
      workspaceIdentity || workspacePath,
      workspacePath,
      resolution.remoteSessionId,
      hostId,
      connectionKind,
    ]),
    target: workspacePath
      ? { workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) }
      : null,
  };
}
