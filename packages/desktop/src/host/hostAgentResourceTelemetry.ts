import type { IDisposable } from "@lcode/rpc";
import type { ILCodeAgentService } from "@lcode/services";
import type { ProcessResourceRuntimeSurface } from "@lcode/shared";
import { HostResponseTypes } from "@lcode/shared";

interface RegisterHostAgentResourceTelemetryOptions {
  agentService: Pick<ILCodeAgentService, "onDynamicProcessResourceSample">;
  postMessage(message: unknown): void;
  runtimeSurface: ProcessResourceRuntimeSurface;
  environmentKey?: string;
}

/**
 * CLI 资源样本的 Host 转发。
 *
 * Host 只做透传：样本的 lane 已由 services 在解析协议通知时按所属进程管理器打好，
 * heap / uptime / 运行机内存 / instanceToken 等新字段一并原样送给 main，
 * 由 main 决定角色归属与聚合。Host 不做任何统计，也不持有窗口。
 */
export function registerHostAgentResourceTelemetry(
  options: RegisterHostAgentResourceTelemetryOptions,
): IDisposable {
  return options.agentService.onDynamicProcessResourceSample()((sample) => {
    try {
      options.postMessage({
        type: HostResponseTypes.AgentResourceSample,
        runtimeSurface: options.runtimeSurface,
        ...(options.environmentKey === undefined ? {} : { environmentKey: options.environmentKey }),
        sample,
      });
    } catch {
      // main 已退出或 IPC 不可用时只丢当前样本，禁止影响 Agent service 通知分发。
    }
  });
}
