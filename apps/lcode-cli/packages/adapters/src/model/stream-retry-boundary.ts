import type { ModelStreamEvent } from "@lcode/contracts";

// Note: these events are buffered, not yielded, until a committed stream boundary appears.
// If a network reset happens first, the partial tool-input attempt can be discarded.
// 非空 reasoning_delta 是用户感知的首个输出 token，不能等待正文或工具边界才释放。
const RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES = new Set<ModelStreamEvent["type"]>([
  "start",
  "text_start",
  "text_end",
  "reasoning_start",
  "reasoning_end",
  "tool_input_start",
  "tool_input_delta",
  "tool_input_end",
]);

export function isRetrySafePreludeStreamEvent(event: ModelStreamEvent): boolean {
  // SDK 把纯签名转成空 reasoning_delta；将其视为已输出会停止 adapter retry，
  // 而 core 无文本、无完整工具调用时也无法恢复。空 delta 随前奏暂存，成功时保留签名原序释放。
  if (event.type === "reasoning_delta" || event.type === "text_delta") {
    return event.text.length === 0;
  }
  return RETRY_SAFE_PRELUDE_STREAM_EVENT_TYPES.has(event.type);
}
