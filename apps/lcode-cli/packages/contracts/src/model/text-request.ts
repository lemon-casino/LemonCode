import type { TraceContext } from "../tracing/tracer.js";
import type { ModelApiCallObservation } from "../telemetry/index.js";
import type { ModelInputMessage } from "./message-content.js";
import type { ModelToolContract, ModelToolChoice } from "./tool-contracts.js";
import type { JsonSchema } from "./protocol-identity.js";
import type { ModelStatusSink, ModelStreamRecoveryStatus } from "./network-status.js";
import type {
  ModelRequestSessionType,
  ModelRetryBudget,
  ModelRequestAdmission,
  ModelRetryYieldGate,
} from "./request-control.js";

export interface ModelRequestSettings {
  temperature?: number;
  maxOutputTokens?: number;
  topP?: number;
  topK?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stopSequences?: string[];
  seed?: number;
}

export interface ModelTextRequest extends ModelRequestSettings {
  messages: ModelInputMessage[];
  tools?: ModelToolContract[];
  toolChoice?: ModelToolChoice;
  responseJsonSchema?: JsonSchema;
  providerOptions?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  abortSignal?: AbortSignal;
  /**
   * Runtime-only hook for propagating model transport status to UI/session layers.
   * This is intentionally omitted from the JSON schema below because it is not serializable.
   */
  statusSink?: ModelStatusSink;
  /**
   * Runtime-only trace context. Serialized requests should pass trace ids through metadata.
   */
  traceContext?: TraceContext;
  /** Runtime-only、强类型的模型 API 调用分类；不会进入 Provider 请求。 */
  modelCall?: ModelApiCallObservation;
  /**
   * Runtime-only 的宿主 session 粗分类。Adapter 将它写入受控归因 header；
   * 不允许调用方通过 provider 静态 headers 覆盖。
   */
  modelRequestSessionType?: ModelRequestSessionType;
  /**
   * Runtime-only 重试预算档位（见 {@link ModelRetryBudget}）。与 modelRequestSessionType 同族：
   * 不进 JSON schema、不进 provider 请求。缺省即 `default`。
   */
  modelRetryBudget?: ModelRetryBudget;
  /**
   * Runtime-only 准入端口（见 {@link ModelRequestAdmission}）：在场时 runner 每次尝试先 acquire、
   * 结束即 release。与 statusSink 同族：不进 JSON schema、不进 provider 请求。
   */
  modelRequestAdmission?: ModelRequestAdmission;
  /**
   * Runtime-only 重试让出闸门。用户已请求安全切换时，Adapter 不再向旧模型发起下一次
   * 物理请求，而是把结构化失败抛回 Core；当前在途请求不会因此被取消。
   */
  shouldYieldRetryToFailover?: ModelRetryYieldGate;
  /**
   * Runtime-only retry continuation offset. Core 只在 retry-yield 接管失配且 selection 未变时
   * 一次性设置；Adapter 用它延续原请求的全局 attempt 编号与有界预算。
   */
  retryAttemptOffset?: number;
  /**
   * Runtime-only SSE idle timeout 递增序号。0/undefined 表示首请求；
   * 每重试一次在 adapter base timeout 上加 30000ms。
   */
  streamIdleTimeoutRetryNumber?: number;
  /** Runtime-only recovery attribution；只进入 status/telemetry，不发送给 Provider。 */
  streamRecovery?: ModelStreamRecoveryStatus;
  /**
   * Runtime-only provider stream 边界开关。compact 隐藏流用它保留首个真实 provider event
   * 与 content block provenance；tool input 提交不受此开关控制，所有请求都等待 AI SDK end。
   */
  preserveProviderStreamBoundaries?: boolean;
}
