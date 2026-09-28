import type { UtilityProcess as ElectronUtilityProcess } from "electron";
import { randomUUID } from "node:crypto";
import {
  HostMessageTypes,
  type HostResourceUsageProcess,
  type HostResourceUsageSnapshotResultResponse,
} from "@lcode/shared";

/**
 * 资源管理器 main → Host 采样 fan-out。
 * 每次快照按 requestId 向每个存活 Host 发一次请求；超时用该 Host 上一轮结果兜底，避免列表闪空。
 */

/** Host 采样 fan-out 的等待上限 */
const HOST_SNAPSHOT_TIMEOUT_MS = 900;

interface PendingHostRequest {
  label: string;
  cancel: () => void;
  resolve: (result: HostResourceUsageSnapshotResultResponse) => void;
}

const pendingHostRequests = new Map<string, PendingHostRequest>();
const requestIdByHost = new Map<string, string>();
const lastHostResults = new Map<string, HostResourceUsageProcess[]>();

/** desktopHostProcess 收到 Host 回帖时调用 */
export function resolveHostResourceUsageResult(
  label: string,
  result: HostResourceUsageSnapshotResultResponse,
): void {
  const pending = pendingHostRequests.get(result.requestId);
  // 关闭/重开后的旧结果不得写回新采样会话；requestId 也必须属于回帖 Host。
  if (!pending || pending.label !== label) return;
  lastHostResults.set(label, result.processes);
  pending.resolve(result);
}

/** Host 退出时清掉它的兜底缓存 */
export function forgetHostResourceUsage(label: string): void {
  const requestId = requestIdByHost.get(label);
  if (requestId) pendingHostRequests.get(requestId)?.cancel();
  lastHostResults.delete(label);
}

export function requestHostResourceUsage(
  label: string,
  child: Pick<ElectronUtilityProcess, "postMessage">,
  timeoutMs: number = HOST_SNAPSHOT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<HostResourceUsageProcess[]> {
  if (signal?.aborted) return Promise.resolve([]);
  // 展示等待超时后仍复用同一轮采样；不能按 UI 节拍不断向慢 Host 追加请求。
  if (requestIdByHost.has(label)) return Promise.resolve(lastHostResults.get(label) ?? []);
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      resolve(lastHostResults.get(label) ?? []);
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      pendingHostRequests.delete(requestId);
      if (requestIdByHost.get(label) === requestId) requestIdByHost.delete(label);
    };
    const cancel = () => {
      finish();
      lastHostResults.delete(label);
      try {
        child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotCancel, requestId });
      } catch {
        /* Host 已退出，无需继续取消。 */
      }
      resolve([]);
    };
    requestIdByHost.set(label, requestId);
    pendingHostRequests.set(requestId, {
      label,
      cancel,
      resolve: (result) => {
        finish();
        resolve(result.processes);
      },
    });
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      child.postMessage({ type: HostMessageTypes.ResourceUsageSnapshotRequest, requestId });
    } catch {
      finish();
      resolve(lastHostResults.get(label) ?? []);
    }
  });
}
