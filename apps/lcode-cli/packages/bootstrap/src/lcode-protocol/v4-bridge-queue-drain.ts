import { V4CommandExecutor } from "../lcode-protocol-v4/commands/executor.js";

import { V4QueuePromotionLeaseUnavailableError } from "../lcode-protocol-v4/commands/handlers/queue.js";

import { shouldAutoDrainV4QueueHead } from "../lcode-protocol-v4/queue-auto-drain.js";

import type { GoalStatus } from "@lcode/contracts";

import type {
  LCodeProtocolAgentServerContext,
  LCodeProtocolSessionRecord,
} from "./server-types.js";

export function createV4QueueAutoDrain(
  context: LCodeProtocolAgentServerContext,
  execute: V4CommandExecutor["execute"],
): (record: LCodeProtocolSessionRecord) => Promise<void> {
  const autoDrainRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const autoDrainV4QueueIfReady = async (record: LCodeProtocolSessionRecord): Promise<void> => {
    const head = context.v4Gateway?.getQueueHead(record.app.sessionId);
    if (!head) {
      // 外层恢复 FIFO 已消费到空；guide 仍只由 core tool-batch 边界行内消费。
      record.app.completeExternalQueueDrain();
      return;
    }
    const coreForegroundBusy = record.app.runtime.getActiveForegroundExecutionId() !== undefined;
    if (
      head.autoDrain &&
      head.dispatchState === "queued" &&
      (record.activeAbortController !== undefined || coreForegroundBusy)
    ) {
      // Bootstrap controller 不覆盖 model-only notification；旧 auto-drain
      // 只看外层锁，因而把“空闲后消费”错误执行成抢占。busy 时不碰 reservation。
      scheduleAutoDrainRetry(record);
      return;
    }
    let targetStatus: GoalStatus | null = null;
    if (head.autoDrain && head.dispatchState === "queued" && !record.activeAbortController) {
      try {
        targetStatus = (await record.app.readTarget())?.status ?? null;
      } catch (error) {
        // target 读取失败时按“未知且未完成”处理；直接提升会让
        // goal verification 的持久终态尚未可证时普通 queue 偷跑。
        context.logger?.warn("v4 auto-drain held because target state could not be read", {
          error: error instanceof Error ? error.message : String(error),
          queueItemId: head.queueItemId,
          sessionId: record.app.sessionId,
        });
        return;
      }
    }
    if (
      !shouldAutoDrainV4QueueHead({
        autoDrain: head.autoDrain,
        dispatchState: head.dispatchState,
        sessionBusy: Boolean(record.activeAbortController) || coreForegroundBusy,
        targetStatus,
      })
    ) {
      return;
    }
    // 暂停队列恢复后，旧项只存在于投影而不在新 activeTurn 内存中；普通文本也必须
    // 和 typed /goal、/compact 一样走完整投影的队首，避免新输入越过旧暂停项。
    try {
      await execute(
        {
          baseRevision: 0,
          clientId: "v4-auto-drain",
          commandId: `auto-${head.kind}-${Date.now()}-${head.queueItemId}`,
          issuedAt: Date.now(),
          payload: { queueItemId: head.queueItemId },
          sessionId: record.app.sessionId,
          type: "sendQueuedNow",
        },
        undefined,
        { autoDrainPromotion: true },
      );
    } catch (error) {
      if (error instanceof V4QueuePromotionLeaseUnavailableError) {
        // precheck 与 handler 之间可能新入队 notification；idle-only 是最终原子判据。
        scheduleAutoDrainRetry(record);
        return;
      }
      // 自动提升失败不能继续越过该 FIFO barrier；重新暂停并保留原项，交用户重试。
      await record.app.setQueueAutoDrain(false);
      context.logger?.warn("v4 auto-drain failed and queue was paused", {
        error: error instanceof Error ? error.message : String(error),
        queueItemId: head.queueItemId,
        sessionId: record.app.sessionId,
      });
    }
  };

  const scheduleAutoDrainRetry = (record: LCodeProtocolSessionRecord): void => {
    const sessionId = record.app.sessionId;
    if (autoDrainRetryTimers.has(sessionId)) return;
    const timer = setTimeout(() => {
      autoDrainRetryTimers.delete(sessionId);
      if (context.sessions.get(sessionId) !== record) return;
      void autoDrainV4QueueIfReady(record).catch((error: unknown) => {
        context.logger?.warn("v4 auto-drain idle reevaluation failed", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      });
    }, 100);
    timer.unref?.();
    autoDrainRetryTimers.set(sessionId, timer);
  };
  return autoDrainV4QueueIfReady;
}
