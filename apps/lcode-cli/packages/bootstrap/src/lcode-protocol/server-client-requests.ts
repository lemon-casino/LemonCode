import type {
  LCodeProtocolMethod,
  LCodeProtocolNotification,
  LCodeProtocolRequest,
  LCodeProtocolRequestId,
} from "@lcode/shared";

import {
  ProtocolRequestError,
  type ParamsSchema,
  type LCodeProtocolClientRequestOptions,
} from "./server-types.js";

const MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS = 10_000;

export type LCodeProtocolOutboundMessage = LCodeProtocolNotification | LCodeProtocolRequest;

interface PendingClientRequest<T> {
  method: string;
  reject: (error: Error) => void;
  resolve: (value: T) => void;
  resultSchema: ParamsSchema<T>;
  requestKeys: Set<string>;
  signal?: AbortSignal;
  timeout?: ReturnType<typeof setTimeout>;
  reannounceTimer?: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
  timedOut?: boolean;
  onLateResponse?: LCodeProtocolClientRequestOptions["onLateResponse"];
}

export interface ProtocolClientRequestState {
  messageSink?: (message: LCodeProtocolOutboundMessage) => void;
  clientDisconnectError?: Error;
  pendingClientRequests: Map<string, PendingClientRequest<unknown>>;
  nextClientRequestId: number;
}

export function requestClient<T>(
  host: ProtocolClientRequestState,
  method: LCodeProtocolMethod,
  params: unknown,
  resultSchema: ParamsSchema<T>,
  options?: LCodeProtocolClientRequestOptions,
): Promise<T> {
  if (host.clientDisconnectError) {
    throw host.clientDisconnectError;
  }
  if (!host.messageSink) {
    throw new ProtocolRequestError(-32020, `No LCode Protocol client is attached for ${method}`);
  }

  return new Promise<T>((resolve, reject) => {
    let active = true;
    const pending: PendingClientRequest<T> = {
      method,
      reject,
      resolve,
      resultSchema,
      requestKeys: new Set(),
      signal: options?.signal,
      onLateResponse: options?.onLateResponse,
    };
    const cleanup = () => {
      active = false;
      cleanupClientRequest(host, pending);
    };
    pending.abortHandler = () => {
      cleanup();
      const error = new ProtocolRequestError(-32021, `Client request cancelled: ${method}`);
      if (pending.timedOut) pending.onLateResponse?.({ error });
      reject(error);
    };
    if (options?.signal?.aborted) {
      pending.abortHandler();
      return;
    }
    if (options?.timeoutMs !== undefined) {
      pending.timeout = setTimeout(() => {
        if (pending.onLateResponse) {
          // 超时只结算等待，原 lifecycle ACK 仍是释放证明；保留原 owner，禁止重发未知动作。
          active = false;
          pending.timedOut = true;
          pending.timeout = undefined;
          if (pending.reannounceTimer) clearTimeout(pending.reannounceTimer);
        } else cleanup();
        reject(
          new ProtocolRequestError(-32022, `Client request timed out: ${method}`, {
            timeoutMs: options.timeoutMs,
          }),
        );
      }, options.timeoutMs);
    }
    options?.signal?.addEventListener("abort", pending.abortHandler, { once: true });
    const sendClientRequest = () => {
      if (!active) {
        return;
      }
      const id = `server-${host.nextClientRequestId++}`;
      const key = String(id);
      pending.requestKeys.add(key);
      host.pendingClientRequests.set(key, pending as PendingClientRequest<unknown>);
      host.messageSink?.({
        id,
        method,
        params,
        ...(options?.trace ? { trace: options.trace } : {}),
      });
    };
    sendClientRequest();
    const reannounceIntervalMs =
      !options?.onLateResponse &&
      options?.reannounceIntervalMs !== undefined &&
      Number.isFinite(options.reannounceIntervalMs) &&
      options.reannounceIntervalMs > 0
        ? Math.floor(options.reannounceIntervalMs)
        : undefined;
    if (reannounceIntervalMs !== undefined) {
      let nextReannounceIntervalMs = reannounceIntervalMs;
      const scheduleReannounce = () => {
        pending.reannounceTimer = setTimeout(() => {
          if (!active) {
            return;
          }
          sendClientRequest();
          nextReannounceIntervalMs = Math.min(
            nextReannounceIntervalMs * 2,
            MAX_CLIENT_REQUEST_REANNOUNCE_INTERVAL_MS,
          );
          scheduleReannounce();
        }, nextReannounceIntervalMs);
      };
      scheduleReannounce();
    }
  });
}

export function resolveClientRequest(
  host: ProtocolClientRequestState,
  id: LCodeProtocolRequestId,
  result: unknown,
): void {
  const key = String(id);
  const pending = host.pendingClientRequests.get(key);
  if (!pending) {
    return;
  }
  cleanupClientRequest(host, pending);
  try {
    const parsed = pending.resultSchema.parse(result);
    if (pending.timedOut) pending.onLateResponse?.({ result: parsed });
    else pending.resolve(parsed);
  } catch (error) {
    const invalid =
      error instanceof Error ? error : new Error(`Invalid response: ${pending.method}`);
    if (pending.timedOut) pending.onLateResponse?.({ error: invalid });
    else pending.reject(invalid);
  }
}

export function rejectClientRequest(
  host: ProtocolClientRequestState,
  id: LCodeProtocolRequestId,
  error: Error,
): void {
  const key = String(id);
  const pending = host.pendingClientRequests.get(key);
  if (!pending) {
    return;
  }
  cleanupClientRequest(host, pending);
  if (pending.timedOut) pending.onLateResponse?.({ error });
  else pending.reject(error);
}

export function cleanupClientRequest<T>(
  host: ProtocolClientRequestState,
  pending: PendingClientRequest<T>,
): void {
  if (pending.timeout) {
    clearTimeout(pending.timeout);
  }
  if (pending.reannounceTimer) {
    clearTimeout(pending.reannounceTimer);
  }
  if (pending.abortHandler) {
    pending.signal?.removeEventListener("abort", pending.abortHandler);
  }
  for (const requestKey of pending.requestKeys) {
    host.pendingClientRequests.delete(requestKey);
  }
  pending.requestKeys.clear();
}
