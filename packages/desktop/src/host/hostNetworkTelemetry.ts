import { HostResponseTypes } from "@lcode/shared";
import { setNetworkTelemetrySink, type NetworkObservation } from "@lcode/rpc";

interface HostNetworkTelemetryParentPort {
  postMessage(message: unknown): void;
}

const pending: NetworkObservation[] = [];
const FLUSH_INTERVAL_MS = 30_000;
const FLUSH_MAX_BATCH = 200;

let flushTimer: ReturnType<typeof setInterval> | null = null;
let activeParentPort: HostNetworkTelemetryParentPort | null = null;

function flushHostNetworkTelemetryBatch(): void {
  if (!activeParentPort || pending.length === 0) {
    return;
  }
  const observations = pending.splice(0, FLUSH_MAX_BATCH);
  try {
    activeParentPort.postMessage({
      type: HostResponseTypes.NetworkTelemetryBatch,
      observations,
    });
  } catch {
    // 遥测批次失败不应影响 host 主流程
  }
}

export function registerHostNetworkTelemetry(
  parentPort: HostNetworkTelemetryParentPort | null | undefined,
): void {
  // 修复原因：desktop host 是 Electron utility process，通信端口在 process.parentPort；
  // node:worker_threads.parentPort 在这里为 null，会导致 LLM/RPC 网络遥测批次无法发回 main。
  activeParentPort = parentPort ?? null;
  setNetworkTelemetrySink((observation) => {
    pending.push(observation);
    if (pending.length >= FLUSH_MAX_BATCH) {
      flushHostNetworkTelemetryBatch();
    }
  });

  flushTimer = setInterval(flushHostNetworkTelemetryBatch, FLUSH_INTERVAL_MS);
}

export function stopHostNetworkTelemetry(): void {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  setNetworkTelemetrySink(null);
  flushHostNetworkTelemetryBatch();
  activeParentPort = null;
}
