import type { TraceContext } from "../tracing/tracer.js";
import type { ToolCallId } from "./shared.js";

export interface CoordinatorResponseRequest {
  childToolCallId: ToolCallId | string;
  summary: string;
  message: string;
  trace: TraceContext;
}

export interface CoordinatorResponseResult {
  status: "success" | "failed";
  responseId: string;
  message: string;
  error?: string;
}

export interface CoordinatorResponsePort {
  // child session/agent/parent identity 由 port closure 绑定，模型不能覆盖路由。
  // 同步返回确保 response command 入父队列后，child tool result 才能完成。
  respond(request: CoordinatorResponseRequest): CoordinatorResponseResult;
}
