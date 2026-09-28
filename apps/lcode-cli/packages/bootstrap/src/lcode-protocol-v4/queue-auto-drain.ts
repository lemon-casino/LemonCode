import type { GoalStatus } from "@lcode/contracts";

/**
 * 普通 queue 的唯一自动提升闸门。fail-open 不在这里开旁路：verifier 仍先把
 * target 持久化为 complete，再与显式 pass 共用这一条判断。
 */
export function shouldAutoDrainV4QueueHead(input: {
  autoDrain: boolean;
  dispatchState: "queued" | "reserved" | "promoting";
  sessionBusy: boolean;
  targetStatus: GoalStatus | null;
}): boolean {
  return (
    input.autoDrain &&
    input.dispatchState === "queued" &&
    !input.sessionBusy &&
    (input.targetStatus === null || input.targetStatus === "complete")
  );
}
