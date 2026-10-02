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
import type { ModelSelection, TurnFileChangeSummary } from "@lcode/contracts";

import { SessionEventType } from "@lcode/contracts";

import { type ErrorAttribution } from "@lcode/shared/lcode-protocol-v4";

export type PushEvent = (
  type: SessionEventType,
  payload: unknown,
  turnId?: string,
  sourceTimestampMs?: number,
) => void;

export type TurnResultForHydration = "success" | "cancelled" | "error_during_execution";

export interface AssistantSynthesisState {
  toolCallCount: number;
  resultType: TurnResultForHydration;
}

export interface SynthesizeOptions {
  sessionId: string;
  /**
   * 当前 session 实际选中模型的权威上下文窗口。
   * transcript 只持久化 token 用量，不持久化模型能力，必须由当前 workspace registry 注入。
   */
  contextWindow?: number;
  /** 合成基准时间戳（确定性：不用 Date.now，由调用方传入首条消息时间兜底）。 */
  baseTimestampMs?: number;
  /**
   * session_entry legacy 源的 goal verify 事实：
   * 有 anchor 的按 anchorAssistantMessageId 落到对应 assistant 之后，
   * 无 anchor/anchor 失配的落到已知时间线末尾；与 timeline part 按 key 去重。
   */
  goalVerificationEntries?: readonly HydratedGoalVerificationEntry[];
  /**
   * workspace checkpoint artifact 按真实 user messageId 重建出的单轮摘要。
   * transcript 没有该字段，必须显式注入合成 ModelComplete 才能保持 live/cold 等价。
   */
  fileChangeSummariesByMessageId?: ReadonlyMap<string, TurnFileChangeSummary>;
}

/** goal verify 事实的归一形态：timeline part（新契约）与 session_entry（legacy 主体）共用。 */
export interface GoalVerificationFact {
  key: string;
  targetId: string;
  verificationId: string;
  goalIteration?: number;
  anchorAssistantMessageId?: string;
  anchorTurnId?: string;
  status?: string;
  verification?: unknown;
}

// ── session_entry legacy 源──
// 历史上 goal verify 主要持久化在 session_entry（本机观测 1,402 行 vs timeline part
// 仅 10 行）；entry.data 保留了原始事件 payload。读取端跨源按 targetId_goalIteration
// 去重：timeline part 与 entry 表达同一事实时只发一次（先到先得，anchor 语义一致）。
export interface HydratedGoalVerificationEntry {
  payload: {
    targetId: string;
    status?: string;
    verificationId: string;
    verification?: unknown;
    goalIteration?: number;
    anchorAssistantMessageId?: string;
    anchorTurnId?: string;
  };
  sequenceNumber?: number;
  timeCreated: number;
}

// ── 轮次选型事实──
// modelChange marker 由投影在 TurnStarted 时对比 lastTurnModel 与 config 生成；
// 冷恢复没有 ModelSelected 事件，这里按每轮的持久化选型事实重建。
// 来源优先级：user prompt 的 model 快照（恒在场、与提交时 config 一致）；
// preface 轮（无 user）取 assistant 消息事实。合成 timeline 宿主消息
// （semantics.kind=timeline_event）的 model 是宿主兼容占位，不是本轮事实。
export interface HydratedTimelineModel {
  modelSelection: ModelSelection;
  previousModelSelection?: ModelSelection | null;
}

export interface TurnOutputCollection {
  failure?: {
    type: string;
    message: string;
    attribution?: ErrorAttribution;
    retryable?: boolean;
    data?: unknown;
  };
  nextIndex: number;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnEndedAtMs: number;
}

export interface HydratedTurnCompletion {
  failure?: TurnOutputCollection["failure"];
  fileChanges?: TurnFileChangeSummary;
  turnId: string;
  resultType: TurnResultForHydration;
  toolCallCount: number;
  historyRoundCount: number;
  turnStartedAtMs: number;
  turnEndedAtMs: number;
}
