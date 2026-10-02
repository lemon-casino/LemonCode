// Transcript → SessionEvent 合成（「reduce(transcript) ≡ reduce(events)」）。
//
// 动机：v4 投影是事件溯源，但部分历史突变（纯对话 fork 复制 message 不复制 event、
// rewind 截断只动 message 库）会让 session 的事件日志无法覆盖可见 transcript。冷订阅
// hydration 从事件日志重建拿不到这些历史（「fork-child 历史」）。
//
// 本模块把 message 库的 transcript 反向合成为 reducer 能消费的 SessionEvent 序列——
// 从而复用整套 ProductProjection 归约逻辑，不必再写一份 message→row 的平行归约器。
// 合成事件是「视图重建」用途：只需产出与真实事件流「归约等价」的最小序列。
// v4 冷恢复只能重放 ProductProjection 认识的事件；如果 transcript 里的
// tool/reasoning/subagent/compact part 不反向合成，重启后历史可见运行态会从快照里消失。
import type { MessagePart, MessageWithParts } from "@lcode/contracts";

import { type TurnResultForHydration } from "./transcript-hydration-types.js";

export function textOfMessage(parts: readonly MessagePart[]): string {
  return parts
    .filter(
      (part): part is Extract<MessagePart, { type: "text" }> =>
        part.type === "text" && part.ignored !== true,
    )
    .map((part) => part.text)
    .join("");
}

function finiteTimeMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function messageCreatedAtMs(message: MessageWithParts): number | undefined {
  return finiteTimeMs(message.info.time.created);
}

function intervalEndOrStartMs(time: { start: number } & Partial<{ end: number }>) {
  return finiteTimeMs(time.end) ?? finiteTimeMs(time.start);
}

function partEndAtMs(part: MessagePart): number | undefined {
  if (part.type === "reasoning") {
    return finiteTimeMs(part.time?.end) ?? finiteTimeMs(part.time?.start);
  }
  if (part.type === "tool" && "time" in part.state) {
    return intervalEndOrStartMs(part.state.time);
  }
  return undefined;
}

export function messageEndAtMs(message: MessageWithParts): number | undefined {
  const time = message.info.time;
  // 冷恢复会同时处理 user/assistant message；user 只有 created，
  // assistant 才可能有 completed，所以这里必须按字段存在性收窄后再取结束时间。
  let end =
    ("completed" in time ? finiteTimeMs(time.completed) : undefined) ?? finiteTimeMs(time.created);
  for (const part of message.parts) {
    const partEnd = partEndAtMs(part);
    if (partEnd !== undefined) {
      end = end === undefined ? partEnd : Math.max(end, partEnd);
    }
  }
  return end;
}

export function normalizeTurnResult(
  current: TurnResultForHydration,
  next: TurnResultForHydration,
): TurnResultForHydration {
  if (current === "cancelled" || next === "cancelled") {
    return "cancelled";
  }
  if (current === "error_during_execution" || next === "error_during_execution") {
    return "error_during_execution";
  }
  return "success";
}
