import { generateText as aiGenerateText, streamText as aiStreamText } from "ai";
import type {
  ModelErrorCode,
  ModelFailureReason,
  ModelProperties,
  ModelRequestAuth,
  ModelTextRequest,
  TraceContext,
} from "@zcode/contracts";
import type { ZCodeProviderAccountAccess } from "@zcode/shared";
import type { AiSdkResolvedModel } from "./model-execution.js";

export type AiSdkGenerateTextOptions = Parameters<typeof aiGenerateText>[0];
export type AiSdkGenerateTextResult = Awaited<ReturnType<typeof aiGenerateText>>;
export type AiSdkStreamTextOptions = Parameters<typeof aiStreamText>[0];
export type AiSdkStreamTextResult = ReturnType<typeof aiStreamText>;
export type ResolvedAiSdkModel = AiSdkResolvedModel & {
  properties: ModelProperties;
  accountAccess?: ZCodeProviderAccountAccess;
};

export interface AiSdkModelRuntime {
  generateText(options: AiSdkGenerateTextOptions): Promise<AiSdkGenerateTextResult>;
  streamText(options: AiSdkStreamTextOptions): AiSdkStreamTextResult;
}

export interface AiSdkModelTextRequest extends ModelTextRequest {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  // Start Plan 的账号鉴权材料按 attempt 刷新；adapter 内部 retry 也是真实模型请求，
  // 必须在每个 attempt 发送前给 core/host 一个刷新机会。
  refreshRuntimeHeadersBeforeAttempt?: (input: {
    accountAccess?: ZCodeProviderAccountAccess;
    attempt: number;
    reason?: "model-request";
    abortSignal?: AbortSignal;
    providerId: string;
    modelId: string;
    traceContext?: TraceContext;
  }) => Promise<{
    headersApplied: boolean;
    requestAuth?: ModelRequestAuth;
  }>;
  // Adapter 单包检查可能读取尚未重建的 contracts 声明；在源边界显式接住 failover runtime hook。
  shouldYieldRetryToFailover?: (input: {
    attempt: number;
    errorCode?: ModelErrorCode;
    reason: ModelFailureReason;
    retryable: boolean;
    statusCode?: number;
    providerId: string;
    modelId: string;
  }) =>
    | boolean
    | {
        policyRevision?: number;
        shouldYield: boolean;
        sourceCommandId?: string;
      }
    | Promise<
        | boolean
        | {
            policyRevision?: number;
            shouldYield: boolean;
            sourceCommandId?: string;
          }
      >;
  /** Core 在 retry-yield claim 失配后恢复同一 selection 的全局 attempt 偏移。 */
  retryAttemptOffset?: number;
  // adapter 测试和开发态常直接使用源文件；这里显式接住 core recovery 透传的 SSE idle timeout 递增序号。
  streamIdleTimeoutRetryNumber?: number;
  // 同一源文件加载边界还需显式接住 compact 专用 provider stream 边界，
  // 避免 contracts 构建产物尚未刷新时 adapter 独立 typecheck 丢失该 runtime-only 字段。
  preserveProviderStreamBoundaries?: boolean;
}

export const defaultRuntime: AiSdkModelRuntime = {
  generateText: aiGenerateText,
  streamText: aiStreamText,
};
