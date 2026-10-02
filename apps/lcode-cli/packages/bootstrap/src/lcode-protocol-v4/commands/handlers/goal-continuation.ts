// Goal 的后台执行借用原 session record/controller，保留同一 promotion lease 与 ready 边界。
import type { SteerTurnOptions, SubmitPromptOptions } from "../../../app/types.js";
import { runWithSessionResidencyFinalization } from "../../../lcode-protocol/session-residency.js";
import type { V4CommandCoreHost, V4SessionRecordView } from "../types.js";

/**
 * goal 变更后的续跑（旧 continueGoalAfterChange 搬运，set/resume 两处共用）：
 * plan 模式或已有 active turn 时不续跑（只落库目标，用户后续显式推进）；
 * 否则模型就绪检查 → 上锁 → 后台 continueActiveTarget。
 */
export async function continueGoalAfterChange(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
    reason: string;
  },
): Promise<void> {
  const isPlanMode = record.app.runtime?.getPlanEnabled?.() ?? record.app.getMode?.() === "plan";
  // continueActiveTarget 是 App 的必选能力；能否继续只取决于当前模式和是否已有活跃 turn。
  const canContinue = !isPlanMode && !record.activeAbortController;
  if (canContinue) {
    await host.ensureModelReady?.(record);
    const abortController = new AbortController();
    record.activeAbortController = abortController;
    void runWithSessionResidencyFinalization(record, () =>
      runGoalContinuationInBackground(host, record, {
        abortController,
        foregroundPromotionLeaseId: params.foregroundPromotionLeaseId,
        inputId: params.inputId,
        intent: params.intent,
      }),
    ).catch(() => {
      // 后台 goal continuation 的失败经事件流降级上报；兜底防 unhandled rejection。
    });
  }
  // 旧协议路径在续跑起跑后立即 afterStateMutation(goal_set/goal_replaced/goal_resumed)
  // → 钩子等价替代；v4 投影经 TargetChanged 事件自然收口。
  await host.afterLegacyStateMutation?.(record, params.reason);
}

async function runGoalContinuationInBackground(
  host: V4CommandCoreHost,
  record: V4SessionRecordView,
  params: {
    abortController: AbortController;
    foregroundPromotionLeaseId?: string;
    inputId: string;
    intent?: SteerTurnOptions["intent"];
  },
): Promise<void> {
  let mutationReason = "goal_continuation_completed";
  try {
    await record.app.continueActiveTarget?.({
      abortSignal: params.abortController.signal,
      inputId: params.inputId,
      intent: params.intent,
      queryId: params.inputId as SubmitPromptOptions["queryId"],
    });
  } catch {
    mutationReason = "goal_continuation_failed";
  } finally {
    if (params.foregroundPromotionLeaseId) {
      record.app.runtime.releaseForegroundPromotionLease(params.foregroundPromotionLeaseId);
    }
    if (record.activeAbortController === params.abortController) {
      // 续跑结束后应立刻释放活跃锁；广播只是后续动作，
      // 如果继续占锁，连续 /goal 会被误判为已有活跃 turn。
      record.activeAbortController = undefined;
    }
  }
  await host.afterLegacyStateMutation?.(record, mutationReason);
}
