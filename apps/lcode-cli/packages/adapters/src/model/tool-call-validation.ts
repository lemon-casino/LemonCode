import { ModelErrorCode } from "@lcode/contracts";
import { AiSdkModelAdapterError } from "./errors.js";

export function normalizeModelToolName(
  value: unknown,
  context: Record<string, unknown>,
): string {
  if (typeof value === "string") {
    const toolName = value.trim();
    if (toolName) {
      return toolName;
    }

    const toolCallId = context.toolCallId;
    const hasClosableToolCallId =
      typeof toolCallId === "string" && toolCallId.trim().length > 0;
    if (context.providerExecuted !== true && hasClosableToolCallId) {
      // client-executed 的空名调用仍可用原 id 闭合。在 Adapter
      // 直接抛错的话，模型收不到同 id 的 tool error，整个 turn 因而停止。
      return value;
    }
  }

  throw new AiSdkModelAdapterError(
    ModelErrorCode.InvalidModelResponse,
    "Model returned an invalid tool call: tool name is empty.",
    { context },
  );
}
