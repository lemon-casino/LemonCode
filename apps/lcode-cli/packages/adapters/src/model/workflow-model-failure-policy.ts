/**
 * workflow 内的模型侧错误策略表。
 *
 * 分类器（failure-classifier.ts）回答的是「主对话要不要自动重试」；这张表回答的是
 * 「workflow 要不要停下来找人」。两张表在 3008/3009/3010（并发上限）上答案相反，这正是
 * 本模块存在的理由：workflow 子代理与工具侧请求持有无上限重试预算（`modelRetryBudget`），
 * 在它们身上，只有**确定性的、需要人来解决的**错误才值得停下 run；其余一切（含分类器判
 * 不可重试的未知业务码、TLS、5xx）一律在内重试，靠 stall 通知做逃生口。
 *
 * runner（attempt 循环的重试闸门）与 bootstrap driver（把 reject 归成 stopRun / askFailed）
 * 共用**同一个**函数：runner 判 retry 的失败绝不会以 stop 到 driver；runner 判 stop 的失败
 * 到 driver 时策略表必判 stop（同一函数、同一输入）。
 */

import { ModelErrorCode, ModelFailureReason } from "@lcode/contracts";
import type { ClassifiedModelFailure } from "./failure-classifier.js";
import { isRetryableFailure } from "./failure-classifier.js";
import type { ModelRetryBudget } from "@lcode/contracts";
import { isUnboundedRetryBudget } from "./retry-budget.js";

/** `ProviderStop` 的判定键：通知文案表按它选句子（不是按 reason）。 */
export type WorkflowProviderStopKind =
  | "auth"
  | "not_configured"
  | "model_unavailable"
  | "invalid_request"
  | "quota"
  | "other";

/**
 * 配额类业务码（Stop 集的一行）。与 failure-provider-business-codes.ts 的
 * TERMINAL_RATE_LIMIT_MAPPING 有意**分开维护**：那张表决定主对话不自动重试，这张表决定
 * workflow 停下来等配额重置 / 充值。1005 在分类器里是 invalid_request，这里必须先按码判
 * 配额再看 reason。
 */
export const WORKFLOW_QUOTA_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "1005",
  "1308",
  "1310",
  "1313",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "2056",
  "20097",
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "exceeded_current_quota_error",
]);

/** 「provider 没配好 / 选型无效」一族的 ModelErrorCode（reason 不一定是 provider_not_configured）。 */
const NOT_CONFIGURED_ERROR_CODES: ReadonlySet<string> = new Set([
  ModelErrorCode.ProviderNotFound,
  ModelErrorCode.ProviderNotConfigured,
  ModelErrorCode.ModelConfigMissing,
  ModelErrorCode.InvalidModelSelection,
  ModelErrorCode.ModelRequestAuthMissing,
]);

export type WorkflowModelFailurePolicy =
  | { decision: "retry" }
  | { decision: "stop"; kind: WorkflowProviderStopKind }
  /** core 已压缩失败才会到这里：节点以 `ContextLimit` 失败，脚本可 catch，未 catch 则 errored。 */
  | { decision: "context_exceeded" }
  | { decision: "cancelled" };

/**
 * 策略表本体。输入是分类器的结果（只读 code / reason / retryable）与 provider 业务码。
 * 顺序有意义：取消最先（它不是错误）；配额按**码**判，先于 reason（1005 的 reason 是
 * invalid_request）；其余按 reason / code；表外一切 = retry。
 */
export function resolveWorkflowModelFailurePolicy(
  failure: Pick<ClassifiedModelFailure, "code" | "reason" | "retryable">,
  providerCode: string | undefined,
): WorkflowModelFailurePolicy {
  if (failure.reason === ModelFailureReason.Cancelled) return { decision: "cancelled" };
  if (providerCode !== undefined && WORKFLOW_QUOTA_PROVIDER_CODES.has(providerCode)) {
    return { decision: "stop", kind: "quota" };
  }
  if (failure.reason === ModelFailureReason.AuthFailed) return { decision: "stop", kind: "auth" };
  if (
    failure.reason === ModelFailureReason.ProviderNotConfigured ||
    NOT_CONFIGURED_ERROR_CODES.has(failure.code)
  ) {
    return { decision: "stop", kind: "not_configured" };
  }
  if (failure.code === ModelErrorCode.ModelNotFound) {
    return { decision: "stop", kind: "model_unavailable" };
  }
  if (failure.reason === ModelFailureReason.ContextExceeded)
    return { decision: "context_exceeded" };
  // 「请求无效」只认 provider 对**请求**的拒绝（3001、HTTP 400/422）。`invalid_model_response`
  // 也被分类器标成 invalid_request，但那是**响应**解析失败——再问一次很可能就好，归 retry。
  if (
    failure.reason === ModelFailureReason.InvalidRequest &&
    failure.code !== ModelErrorCode.InvalidModelResponse
  ) {
    return { decision: "stop", kind: "invalid_request" };
  }
  return { decision: "retry" };
}

/**
 * runner 重试闸门的替换点：有界预算照旧读分类器的 `retryable`（主对话一字不动）；无上限
 * 预算（workflow 流量）改读策略表——`retry` 即可重试，`stop` / `context_exceeded` 不重试。
 * 取消由调用方在此之前单独短路（两处 runner 都已如此）。
 */
export function retryAllowedByFailurePolicy(
  failure: ClassifiedModelFailure,
  retryBudget: ModelRetryBudget | undefined,
  providerCode: string | undefined,
): boolean {
  if (!isUnboundedRetryBudget(retryBudget)) return isRetryableFailure(failure);
  return resolveWorkflowModelFailurePolicy(failure, providerCode).decision === "retry";
}

/** driver 侧从 adapter 错误读出的事实：策略裁决 + 拼 `ProviderStopDetails` 要的字段。 */
export interface WorkflowModelFailureInspection {
  policy: WorkflowModelFailurePolicy;
  /** contracts `ModelFailureReason` 的值。 */
  reason: string;
  providerCode?: string;
  providerId?: string;
  modelId?: string;
  /** adapter 错误的 message（映射过的业务码下就是 provider 原文）。 */
  rawMessage?: string;
  /** 配额类且 provider 给了 Retry-After 时的重置时刻（epoch ms）。 */
  resetAt?: number;
}

/**
 * 按**形状**读 adapter 错误（`AiSdkModelAdapterError`：`name` + `context.reason` …），直接或
 * 一层 `cause` 之内；bootstrap 与 adapters 之间可能存在两份类定义（dist 边界），形状不会漂。
 * 不是模型层错误时返回 undefined（driver 照旧归成 DriverError）。
 */
export function inspectWorkflowModelFailure(
  error: unknown,
): WorkflowModelFailureInspection | undefined {
  const direct = readAdapterError(error);
  const found =
    direct ?? readAdapterError((error as { cause?: unknown } | undefined)?.cause ?? undefined);
  if (found === undefined) return undefined;
  const { context, code, message } = found;
  const reason = stringValue(context.reason);
  if (reason === undefined) return undefined;
  const providerCode = codeValue(context.providerCode);
  const policy = resolveWorkflowModelFailurePolicy(
    {
      code: code as ClassifiedModelFailure["code"],
      reason: reason as ClassifiedModelFailure["reason"],
      retryable: context.retryable === true,
    },
    providerCode,
  );
  const retryAfterMs = context.retryAfterMs;
  const inspection: WorkflowModelFailureInspection = { policy, reason };
  if (providerCode !== undefined) inspection.providerCode = providerCode;
  const providerId = stringValue(context.providerId);
  if (providerId !== undefined) inspection.providerId = providerId;
  const modelId = stringValue(context.modelId);
  if (modelId !== undefined) inspection.modelId = modelId;
  if (message.length > 0) inspection.rawMessage = message;
  if (
    policy.decision === "stop" &&
    policy.kind === "quota" &&
    typeof retryAfterMs === "number" &&
    Number.isFinite(retryAfterMs) &&
    retryAfterMs > 0
  ) {
    inspection.resetAt = Date.now() + retryAfterMs;
  }
  return inspection;
}

function readAdapterError(
  error: unknown,
): { context: Record<string, unknown>; code: string; message: string } | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    name?: unknown;
    code?: unknown;
    context?: unknown;
    message?: unknown;
  };
  if (candidate.name !== "AiSdkModelAdapterError") return undefined;
  const context =
    typeof candidate.context === "object" && candidate.context !== null
      ? (candidate.context as Record<string, unknown>)
      : {};
  return {
    context,
    code: typeof candidate.code === "string" ? candidate.code : "",
    message: typeof candidate.message === "string" ? candidate.message : "",
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** provider 业务码可能是数字（响应体原样）也可能是字符串；统一成字符串键。 */
function codeValue(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  return stringValue(value);
}
