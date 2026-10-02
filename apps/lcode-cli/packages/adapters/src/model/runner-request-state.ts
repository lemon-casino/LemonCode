import type { Logger, ModelStatusSink } from "@lcode/contracts";
import type { EnvRecord } from "./model-execution.js";
import type { ResolvedAiSdkModelRetryOptions } from "./retry-policy.js";
import type { DeferredRetryYieldGate } from "./runner-failover-yield.js";
import type {
  AiSdkModelRuntime,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";

export interface ModelRunnerInput {
  debugDir?: string;
  env: EnvRecord;
  logger?: Logger;
  request: AiSdkModelTextRequest;
  resolveModel: () => ResolvedAiSdkModel;
  resolved: ResolvedAiSdkModel;
  retry: ResolvedAiSdkModelRetryOptions;
  runtime: AiSdkModelRuntime;
  statusSink?: ModelStatusSink;
  modelIoFullRetentionEnabled: boolean;
}

// 一个逻辑请求只有 runner 持有这份状态；helper 借用相应字段，不复制历史或 retry gate。
export interface ModelRunnerRetryState {
  requestMessages: AiSdkModelTextRequest["messages"];
  signatureRepairAttempted: boolean;
  emptyCompletionRetryCount: number;
  pendingRetryYield: DeferredRetryYieldGate | undefined;
}
