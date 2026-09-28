import type { TuiCopy } from "@lcode/i18n";
import type React from "react";
import type { NetworkRequest } from "./app-model.js";
import { modelNetworkRequestTargetFromPayload } from "./app-event-data.js";
import { formatDuration, numberField, stringField } from "./state.js";

const MAX_NETWORK_REQUESTS = 8;
const MODEL_HTTP_METHOD = "POST";
const MODEL_NETWORK_SOURCE = "model";
const UNKNOWN_NETWORK_SOURCE = "unknown";

export function applyNetworkRequestEvent(
  payload: Record<string, unknown>,
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>,
): void {
  const requestId = stringField(payload, "requestId");
  const method = stringField(payload, "method");
  const url = stringField(payload, "url");
  const status = payload.status;
  if (
    !requestId ||
    !method ||
    !url ||
    (status !== "pending" && status !== "complete" && status !== "error")
  ) {
    return;
  }

  const now = new Date().toISOString();
  const request: NetworkRequest = {
    attempt: numberField(payload, "attempt"),
    completedAt: stringField(payload, "completedAt"),
    durationMs: numberField(payload, "durationMs"),
    error: stringField(payload, "error"),
    id: requestId,
    method,
    requestId,
    source: stringField(payload, "source") ?? UNKNOWN_NETWORK_SOURCE,
    startedAt: stringField(payload, "startedAt") ?? now,
    status,
    statusCode: numberField(payload, "statusCode"),
    updatedAt: now,
    url,
  };

  setNetworkRequests((current) => prependNetworkRequest(current, request));
}

export function applyModelNetworkEvent(
  payload: Record<string, unknown>,
  setNetworkRequests: React.Dispatch<React.SetStateAction<NetworkRequest[]>>,
  setStatus: (status: string) => void,
  copy: TuiCopy,
): void {
  const type = stringField(payload, "type");
  const requestId = stringField(payload, "requestId");
  if (!type || !requestId) return;

  const target = modelNetworkRequestTargetFromPayload(payload);
  const now = new Date().toISOString();
  const status =
    type === "model_request_failed" || type === "model_stream_stalled"
      ? "error"
      : type === "model_request_completed"
        ? "complete"
        : "pending";
  const request: NetworkRequest = {
    attempt: numberField(payload, "attempt"),
    completedAt: status === "pending" ? undefined : now,
    durationMs: numberField(payload, "durationMs"),
    error: stringField(payload, "message") ?? stringField(payload, "reason"),
    id: requestId,
    method: MODEL_HTTP_METHOD,
    model: target.model,
    provider: target.provider,
    requestId,
    source: MODEL_NETWORK_SOURCE,
    startedAt: now,
    status,
    statusCode: numberField(payload, "statusCode"),
    updatedAt: now,
    url: target.url,
  };
  setNetworkRequests((current) => prependNetworkRequest(current, request));

  if (type === "model_retry_scheduled") {
    const attempt = numberField(payload, "attempt") ?? 1;
    const maxAttempts = numberField(payload, "maxAttempts") ?? attempt;
    const delayMs = numberField(payload, "delayMs");
    const reason = stringField(payload, "reason") ?? "retry";
    setStatus(
      copy.model.retryScheduled({
        attempt,
        delay: formatDuration(delayMs),
        maxAttempts,
        reason,
      }),
    );
  } else if (type === "model_request_failed") {
    const message = stringField(payload, "message") ?? "request failed";
    setStatus(copy.model.requestFailed(message));
  } else if (type === "model_stream_stalled") {
    setStatus(copy.model.streamStalled);
  }
}

function prependNetworkRequest(
  current: NetworkRequest[],
  request: NetworkRequest,
): NetworkRequest[] {
  return [request, ...current.filter((item) => item.id !== request.id)].slice(
    0,
    MAX_NETWORK_REQUESTS,
  );
}
