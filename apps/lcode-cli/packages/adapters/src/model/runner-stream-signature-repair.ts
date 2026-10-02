import { repairReasoningHistoryAfterSignatureRejection } from "./reasoning-history-normalization.js";

import type { ModelRunnerRetryState } from "./runner-request-state.js";
import type { StreamAttemptState, StreamRunnerInput } from "./runner-stream-state.js";

type AttemptState = Pick<StreamAttemptState, "attempt" | "statusContext" | "resolved">;
type RetryState = Pick<ModelRunnerRetryState, "requestMessages" | "signatureRepairAttempted">;

export function repairStreamThinkingSignature(
  input: Pick<StreamRunnerInput, "logger" | "retry">,
  retryState: RetryState,
  state: AttemptState,
  error: unknown,
): boolean {
  if (retryState.signatureRepairAttempted || state.resolved.providerKind !== "anthropic") {
    return false;
  }
  const repairedMessages = repairReasoningHistoryAfterSignatureRejection(
    retryState.requestMessages,
    error,
  );
  if (!repairedMessages) return false;

  // 签名只对生成它的 thinking block 有效。流尚未提交输出时，只替换
  // 本次请求副本，并给一次不占普通 retry 预算且拥有新 requestId 的物理请求机会；
  // 不能把清理结果写回 canonical history。
  retryState.signatureRepairAttempted = true;
  retryState.requestMessages = repairedMessages;
  input.logger?.warn("Retrying model stream after thinking signature rejection", {
    attempt: state.attempt,
    event: "model.reasoning_signature_repair.retry",
    maxAttempts: input.retry.maxAttempts + 1,
    nextAttempt: state.attempt + 1,
    requestId: state.statusContext.requestId,
    status: "waiting",
  });
  return true;
}
