import {
  SessionEventType,
  getCurrentModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelStatusSink,
} from "@lcode/contracts";
import { withModelInvocationContext } from "../../runtime/methods/runtime-model.js";
import type { ToolExecutionContext } from "../types.js";

/**
 * 工具内部模型请求的默认状态出口。
 *
 * `statusSink` 不能是每个调用点各自的职责——WebSearch 记得设，WebFetch 处理没有。
 * 没有 sink 的请求照样过准入闸门、照样排队，但 runner 发的 queued / admitted / 429 事件没有去处：
 * 执行器的 deadline 不知道该暂停（实测 18 次 WebFetch 在队里等了 20–45 s 后按
 * 60 s 超时被取消，错误里 `queuedMs: 0`），driver 也看不见这个子代理在等。
 * 与准入端口同一处置：默认值绑在**边界**上而不是靠调用点记得——执行器交给 handler 的
 * `context.model` 先套一层，调用点没设 sink 时补上会话事件出口；调用点自己设了则原样保留。
 */
export function createToolModelStatusSink(
  context: Pick<ToolExecutionContext, "emitEvent" | "sessionId" | "turnId" | "traceId">,
): ModelStatusSink | undefined {
  if (!context.emitEvent) return undefined;

  return {
    publish: async (statusEvent: ModelNetworkStatusEvent) => {
      await context.emitEvent?.({
        id: crypto.randomUUID() as never,
        sessionId: context.sessionId,
        turnId: context.turnId,
        type: SessionEventType.ModelNetworkStatus,
        timestamp: new Date(),
        traceId: context.traceId,
        sequenceNumber: 0,
        payload: statusEvent,
      });
    },
  };
}

/** 调用点未设 `statusSink` 时补默认出口；设了的保留（默认值不压调用层）。 */
export function withDefaultToolModelStatusSink(
  model: Model | undefined,
  sink: ModelStatusSink | undefined,
): Model | undefined {
  if (model === undefined || sink === undefined) return model;
  return withModelInvocationContext(model, () =>
    getCurrentModelInvocationContext()?.statusSink === undefined ? { statusSink: sink } : {},
  );
}
