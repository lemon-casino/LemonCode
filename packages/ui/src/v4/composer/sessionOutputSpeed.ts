import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import { isLiveOutputPhase } from "./sessionTokenStats.js";

export interface SessionOutputSpeed {
  liveRate: number | null;
  average: { rate: number; completedAt: number } | null;
  pending: boolean;
}

/** 纯展示派生：真实用量仍由 CLI 持有，不在 Renderer 建第二份请求或 Token 账本。 */
export function readSessionOutputSpeed(
  snapshot: ConversationSnapshot | null | undefined,
  observedRate: number | null,
): SessionOutputSpeed {
  if (!snapshot) return { liveRate: null, average: null, pending: false };
  const active = isLiveOutputPhase(snapshot.control.phase);
  const recorded = snapshot.usage.modelOutput;
  const output = recorded?.turnId === snapshot.rows.window.at(-1)?.turnId ? recorded : null;
  // Bug 原因：隐藏推理/工具 JSON 没有可见文本，旧采样器没有读数；完成请求后
  // 不能把工具阶段保留的旧可见速率继续称为实时，应切到有明确标签的真实请求均速。
  const canUseLive = active && (!recorded || Boolean(output?.activeRequestId));
  const liveRate =
    canUseLive && observedRate !== null && Number.isFinite(observedRate) && observedRate > 0
      ? observedRate
      : null;
  const request = output?.lastRequest;
  const measured = request ? (request.outputTokens * 1_000) / request.durationMs : null;
  const validAverage =
    request &&
    Number.isFinite(request.outputTokens) &&
    request.outputTokens > 0 &&
    Number.isFinite(request.durationMs) &&
    request.durationMs > 0 &&
    Number.isFinite(request.completedAt) &&
    request.completedAt >= 0 &&
    measured !== null &&
    Number.isFinite(measured) &&
    measured > 0;
  return {
    liveRate,
    average: validAverage ? { rate: measured!, completedAt: request.completedAt } : null,
    pending: canUseLive && liveRate === null,
  };
}

/** 同时发生的可见速率可汇总，不同请求时间窗的均速只选择最近记录。 */
export function combineOutputSpeeds(speeds: readonly SessionOutputSpeed[]): SessionOutputSpeed {
  const liveRates = speeds.flatMap((speed) => (speed.liveRate === null ? [] : [speed.liveRate]));
  return {
    liveRate: liveRates.length ? liveRates.reduce((sum, rate) => sum + rate, 0) : null,
    average: speeds.reduce<SessionOutputSpeed["average"]>(
      (latest, speed) =>
        speed.average && (!latest || speed.average.completedAt > latest.completedAt)
          ? speed.average
          : latest,
      null,
    ),
    pending: speeds.some((speed) => speed.pending),
  };
}
