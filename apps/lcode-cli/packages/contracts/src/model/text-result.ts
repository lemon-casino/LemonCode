import type { ModelUsage } from "./usage.js";
import type { ModelReasoningContentBlock, ModelToolCall } from "./message-content.js";

export interface ModelSource {
  type: "source";
  sourceType: "url" | "document";
  id?: string;
  url?: string;
  title?: string;
  mediaType?: string;
  filename?: string;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelToolResult {
  id: string;
  name: string;
  input: unknown;
  output: unknown;
  providerExecuted?: boolean;
  providerMetadata?: Record<string, unknown>;
}

export interface ModelTextResult {
  text: string;
  finishReason: string;
  usage: ModelUsage;
  reasoning?: ModelReasoningContentBlock[];
  toolCalls?: ModelToolCall[];
  toolResults?: ModelToolResult[];
  sources?: ModelSource[];
  providerMetadata?: Record<string, unknown>;
}

export type ModelStreamEvent =
  | {
      type: "start";
    }
  | {
      /**
       * Compact-only replay boundary。Adapter 从 raw provider stream 提炼真实边界；
       * 无 raw provenance 的 direct tool-call 校验失败可补一个 inferred commit。
       * 事件不携带 provider 正文，也不进入 session/UI streaming。
       */
      type: "compact_stream_boundary";
      boundary: "provider_response_start" | "inferred_content_block_stop";
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_start";
      blockType: string | null;
      index: number | null;
    }
  | {
      /** Raw delta 只携带 provenance type，不携带正文。 */
      type: "compact_stream_boundary";
      boundary: "provider_content_block_delta";
      deltaType: string | null;
      index: number | null;
    }
  | {
      type: "compact_stream_boundary";
      boundary: "provider_content_block_stop";
      index: number | null;
    }
  | {
      /** 每个 provider message_delta 覆盖当前 stop reason 状态，后续 null 会清掉先前值。 */
      type: "compact_stream_boundary";
      boundary: "provider_stop_reason";
      present: boolean;
    }
  | {
      type: "text_start";
      id: string;
    }
  | {
      type: "text_delta";
      id?: string;
      text: string;
    }
  | {
      type: "text_end";
      id: string;
    }
  | {
      type: "reasoning_start";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_delta";
      id?: string;
      text: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "reasoning_end";
      id: string;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "tool_input_start";
      id: string;
      toolName: string;
      providerExecuted?: boolean;
    }
  | {
      type: "tool_input_delta";
      id: string;
      delta: string;
    }
  | {
      type: "tool_input_end";
      id: string;
    }
  | {
      type: "tool_call";
      toolCall: ModelToolCall;
    }
  | {
      type: "finish";
      finishReason: string;
      providerMetadata?: Record<string, unknown>;
      usage: ModelUsage;
    }
  | {
      type: "error";
      error: unknown;
    };
