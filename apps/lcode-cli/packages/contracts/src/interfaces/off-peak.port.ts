// ============================================================
// Off-Peak Port - idle-time task creation boundary
// ============================================================
// 与 AutomationPort 兄弟并列。create 返回判别联合而非抛错：失败分类
// （额度 3103 / 资格 3101 / 网络等）必须跨 CLI↔host 协议保真到 handler，
// 供模型收到稳定、可行动的错误提示，禁止降级为 message 字符串判断。

import type { OffPeakCreateInput, OffPeakTaskSummary } from "../tools/off-peak.js";

export type OffPeakCreateFailureStage = "client_validation" | "ticket_request" | "local_persist";

export type OffPeakCreateErrorCategory =
  | "client_validation"
  | "eligibility_3101"
  | "quota_3103"
  | "network"
  | "invalid_response"
  | "local_persist"
  | "unknown";

export type OffPeakCreateOutcome =
  | { ok: true; task: OffPeakTaskSummary }
  | {
      ok: false;
      failureStage: OffPeakCreateFailureStage;
      errorCategory: OffPeakCreateErrorCategory;
      errorCode: string;
    };

export function isOffPeakQuotaFailure(
  outcome: OffPeakCreateOutcome,
): outcome is Extract<OffPeakCreateOutcome, { ok: false }> {
  return !outcome.ok && outcome.errorCategory === "quota_3103";
}

export function isOffPeakEligibilityFailure(
  outcome: OffPeakCreateOutcome,
): outcome is Extract<OffPeakCreateOutcome, { ok: false }> {
  return !outcome.ok && outcome.errorCategory === "eligibility_3101";
}

export interface OffPeakCreateContext {
  /** 当前工具调用所在 session；作为闲时任务的绑定会话（首跑 resume 该会话，对齐 CronCreate targetTaskId）。 */
  sessionId?: string;
}

export interface OffPeakPort {
  create(input: OffPeakCreateInput, context?: OffPeakCreateContext): Promise<OffPeakCreateOutcome>;
  list(): Promise<OffPeakTaskSummary[]>;
}
