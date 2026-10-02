import type { ModelRequestFailedStatusEvent } from "@lcode/contracts/model";
import { ModelFailureReason } from "@lcode/contracts/model";
import type {
  AgentTelemetryErrorCategory,
  ModelApiOperationKind,
  ModelAttemptFailureStage,
  ModelAttemptSpanWriter,
  ResolvedModelTelemetryDescriptor,
} from "@lcode/contracts/telemetry";

export function setEffectiveReasoning(
  writer: ModelAttemptSpanWriter,
  target: ResolvedModelTelemetryDescriptor,
): void {
  writer.setEffectiveReasoningState(target.reasoning.effectiveState);
  writer.setEffectiveReasoningControl(target.reasoning.effectiveControl);
  if (target.reasoning.effectiveLevel) {
    writer.setEffectiveReasoningLevel(target.reasoning.effectiveLevel);
  }
  if (target.reasoning.effectiveBudgetTokens !== undefined) {
    writer.setEffectiveReasoningBudgetTokens(target.reasoning.effectiveBudgetTokens);
  }
}

export function apiOperationFromRoute(route: string | undefined): ModelApiOperationKind {
  const normalized = route?.toLowerCase() ?? "";
  if (normalized.includes("/chat/completions")) return "chat_completions";
  if (normalized.includes("/responses")) return "responses";
  if (normalized.includes("/messages")) return "messages";
  if (normalized.includes(":generatecontent") || normalized.includes(":streamgeneratecontent")) {
    return "generate_content";
  }
  return "unknown";
}

export function failureStage(event: ModelRequestFailedStatusEvent): ModelAttemptFailureStage {
  return event.errorPhase === "prepare" ? "configuration" : (event.errorPhase ?? "unhandled");
}

export function errorCategory(event: ModelRequestFailedStatusEvent): AgentTelemetryErrorCategory {
  switch (event.reason) {
    case ModelFailureReason.AuthFailed:
      return "authentication";
    case ModelFailureReason.ProviderNotConfigured:
    case ModelFailureReason.InvalidRequest:
      return "configuration";
    case ModelFailureReason.RateLimited:
      return "rate_limit";
    case ModelFailureReason.Timeout:
    case ModelFailureReason.StreamIdleTimeout:
      return "timeout";
    case ModelFailureReason.NetworkError:
    case ModelFailureReason.StaleConnection:
    case ModelFailureReason.TlsError:
      return "network";
    case ModelFailureReason.Cancelled:
      return "cancelled";
    case ModelFailureReason.ContextExceeded:
    case ModelFailureReason.ProviderOverloaded:
    case ModelFailureReason.ServerError:
    case ModelFailureReason.ProxyError:
    case ModelFailureReason.AuthRefresh:
    case ModelFailureReason.OffpeakQueued:
      return "provider";
    default:
      return "unknown";
  }
}
