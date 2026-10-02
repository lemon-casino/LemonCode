import type {
  TargetChangedPayload,
  TargetCompletionVerificationPayload,
} from "./session.events.js";
import { SessionEventType as EventTypes } from "./session.events.js";
import { failedGoalCompletionVerification } from "../tools/target.js";
import type { EventProjectionHandlers } from "./event-reducer-types.js";

export const goalProjectionHandlers: EventProjectionHandlers = {
  [EventTypes.TargetChanged]: (p, e) => {
    const payload = e.payload as TargetChangedPayload;
    const targetChanged =
      payload.action === "set" && payload.previousTarget?.targetID !== payload.target?.targetID;
    return {
      ...p,
      target: payload.target,
      targetCompletionVerifications: targetChanged ? [] : p.targetCompletionVerifications,
      targetCompletionVerificationTimeline: targetChanged
        ? []
        : p.targetCompletionVerificationTimeline,
      updatedAt: e.timestamp,
    };
  },

  [EventTypes.TargetCompletionVerification]: (p, e) => {
    const payload = e.payload as TargetCompletionVerificationPayload;
    const existing = p.targetCompletionVerificationTimeline.find(
      (item) =>
        item.verificationId === payload.verificationId ||
        (payload.goalIteration !== undefined &&
          item.targetId === payload.targetId &&
          item.goalIteration === payload.goalIteration),
    );
    const startedAt =
      existing?.startedAt ?? (payload.status === "started" ? e.timestamp : undefined);
    // goal 校验的 UI 身份是 target + iteration；verificationId 只是单次尝试。
    // started/completed 或恢复重放如果只按 verificationId 合并，会把同一轮目标校验追加成多条横线。
    const goalIteration =
      payload.goalIteration ??
      existing?.goalIteration ??
      p.targetCompletionVerificationTimeline.length + 1;
    const nextTimelineItem = {
      targetId: payload.targetId,
      status: payload.status,
      verificationId: payload.verificationId,
      ...(payload.verification ? { verification: payload.verification } : {}),
      goalIteration,
      ...((payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId)
        ? {
            anchorAssistantMessageId:
              payload.anchorAssistantMessageId ?? existing?.anchorAssistantMessageId,
          }
        : {}),
      ...((payload.anchorTurnId ?? existing?.anchorTurnId)
        ? { anchorTurnId: payload.anchorTurnId ?? existing?.anchorTurnId }
        : {}),
      ...(startedAt ? { startedAt } : {}),
      updatedAt: e.timestamp,
    };
    const nextTimeline = existing
      ? p.targetCompletionVerificationTimeline.map((item) =>
          item === existing ? nextTimelineItem : item,
        )
      : [...p.targetCompletionVerificationTimeline, nextTimelineItem];
    return {
      ...p,
      // failed_closed/cancelled 没有 model_complete 结果事件，必须把 lifecycle 结论补进摘要账本；
      // 正常 completed 继续由既有 model_complete 投影，避免新旧事件把同一次校验计两遍。
      targetCompletionVerifications:
        payload.status === "failed_closed" || payload.status === "cancelled"
          ? [
              ...p.targetCompletionVerifications,
              payload.verification ??
                failedGoalCompletionVerification(
                  "The completion verifier did not return a persisted result.",
                ),
            ]
          : p.targetCompletionVerifications,
      targetCompletionVerificationTimeline: nextTimeline,
      updatedAt: e.timestamp,
    };
  },
};
