import type { AskActivity, InstanceRef } from "@lcode/dynamic-workflow";
import type { WorkflowClock } from "./workflow-driver-concurrency.js";
import { defaultSchedule, sameAskAttempt } from "./workflow-driver-helpers.js";

const ACTIVITY_UPDATE_INTERVAL_MS = 1_000;

/** 只合并展示摘要；每个闹钟绑定原 ask/attempt，绝不在 flush 时重写源时间。 */
export function createActivityEmitter(input: {
  live: () => InstanceRef | undefined;
  clock?: WorkflowClock;
  emit: (instance: InstanceRef, activity: AskActivity) => void;
}) {
  const now = input.clock?.now ?? Date.now;
  const schedule = input.clock?.schedule ?? defaultSchedule;
  let lastSentAt = -Infinity;
  let pending: { instance: InstanceRef; activity: AskActivity } | undefined;
  let cancelTimer: (() => void) | undefined;
  let generation = 0;

  const clear = () => {
    generation++;
    cancelTimer?.();
    cancelTimer = undefined;
    pending = undefined;
  };
  const send = (instance: InstanceRef, activity: AskActivity) => {
    if (!sameAskAttempt(input.live(), instance)) return;
    lastSentAt = now();
    input.emit(instance, activity);
  };
  return {
    offer(instance: InstanceRef, activity: AskActivity, immediate: boolean) {
      if (!sameAskAttempt(input.live(), instance)) {
        clear();
        return;
      }
      if (immediate || now() - lastSentAt >= ACTIVITY_UPDATE_INTERVAL_MS) {
        clear();
        send(instance, activity);
        return;
      }
      pending = { instance, activity };
      if (cancelTimer !== undefined) return;
      const original = { ...instance };
      const scheduledGeneration = generation;
      cancelTimer = schedule(
        () => {
          // 已撤销的回调即使迟到，也不能刷新新 ask 或抢走新一代 timer 的 pending。
          if (scheduledGeneration !== generation) return;
          const latest = pending;
          clear();
          if (latest !== undefined && sameAskAttempt(latest.instance, original)) {
            send(original, latest.activity);
          }
        },
        Math.max(0, ACTIVITY_UPDATE_INTERVAL_MS - (now() - lastSentAt)),
      );
    },
    flush() {
      const latest = pending;
      clear();
      if (latest !== undefined) send(latest.instance, latest.activity);
    },
    clear,
    reset() {
      clear();
      lastSentAt = -Infinity;
    },
  };
}
