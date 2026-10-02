import type {
  AiSdkGenerateTextOptions,
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import type { ModelStatusContext } from "./runner-status.js";

export interface GenerateAttemptState {
  attempt: number;
  retryBudgetAttempt: number;
  attemptRequest: AiSdkModelTextRequest;
  startedAt: number;
  resolved: ResolvedAiSdkModel;
  statusContext: ModelStatusContext;
  options: AiSdkGenerateTextOptions | undefined;
  requestInvocationCompleted: boolean;
  requestHeaders: Record<string, string>;
  requestHeaderCount: number;
}
