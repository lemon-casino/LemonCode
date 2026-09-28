// turn_complete 的处理：用量/缓存统计 + 结果兜底。
//
// 两件事放一起是因为它们同源于一条事件；顺带让 app-events.ts 的 switch 留在 max-lines 之内。
import type React from "react";
import type { ModelUsageSummary } from "@lcode/contracts";
import type { CacheStats, Message } from "./app-model.js";
import { cacheStatsFromPayload, usageFromPayload } from "./app-event-data.js";
import { projectedTranscriptHasResponse } from "./app-transcript-stream.js";
import { stringField } from "./state.js";

/**
 * turn_complete 携带权威 `response`；只在转写里**还没有**这段文本时补上。
 *
 * 为什么需要：通知驱动的回合没有 submitPrompt，也就没有 applyResult 去追加结果。绝大多数
 * 情况流式事件已经把文本画出来了，但只有工具调用、或流在
 * 中途错误断掉的回合会一个字都不留——那时这条兜底就是唯一的答案来源。
 *
 * 为什么不会双写：判据是**内容**而不是时序。`projectedTranscriptHasResponse` 已存在于
 * appendAgentResult 的同一条守卫上，所以无论这里先补还是 applyResult 先补，另一边都会看到
 * 内容已在而跳过——与事件 id 去重同一个思路（按内容/身份幂等，不赌先后）。
 *
 * 但这条对称性有个前提：守卫只扫 `streamProjected` 的消息，所以这里补上的消息
 * 必须**自己带 `streamProjected: true`**——否则用户回合里"流断了但 turn_complete 带着
 * response"的场景会先由这里补一条普通消息，随后 applyResult 的守卫看不见它、再补一条，
 * 同一段回答出现两次。`transcriptText` 对无 parts 的消息回落到 `content`，因此不需要合成 parts。
 */
export function applyTurnCompleteFallbackResponse(
  payload: Record<string, unknown>,
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>,
): void {
  const response = stringField(payload, "response");
  if (!response || response.trim().length === 0) return;
  setMessages((current) =>
    projectedTranscriptHasResponse(current, response)
      ? current
      : [...current, { content: response, role: "agent", streamProjected: true }],
  );
}

export function applyTurnCompleteEvent(
  payload: Record<string, unknown>,
  setUsage: React.Dispatch<React.SetStateAction<ModelUsageSummary | undefined>>,
  setCacheStats: React.Dispatch<React.SetStateAction<CacheStats | undefined>>,
): void {
  const turnUsage = usageFromPayload(payload);
  if (turnUsage) setUsage(turnUsage);

  const cacheStats = cacheStatsFromPayload(payload);
  if (cacheStats) setCacheStats(cacheStats);
}
