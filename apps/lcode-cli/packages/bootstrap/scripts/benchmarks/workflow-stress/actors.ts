import assert from "node:assert/strict";
import { SessionEventType, type SessionEvent, type SessionId } from "@lcode/contracts";
import type { AgentRuntime, ExecuteTurnOptions, TurnResult } from "@lcode/core";
import type { ModelNetworkStatusEvent } from "@lcode/contracts";

interface Turn {
  id: string;
  queryId: string;
  resolve: (value: TurnResult) => void;
  reject: (reason: unknown) => void;
  release: () => void;
}

/** Only the synthetic runtime port is replaced; production observation/driver is not. */
export class SyntheticActor {
  readonly listeners = new Set<(event: SessionEvent) => void>();
  readonly sessionId: SessionId;
  readonly ordinal: number;
  current: Turn | undefined;
  closed = 0;
  turnCount = 0;
  requestCount = 0;
  completedRequests = 0;
  private sequence = 0;
  private requestId = "";

  constructor(sessionId: SessionId, ordinal: number) {
    this.sessionId = sessionId;
    this.ordinal = ordinal;
  }

  readonly runtime = {
    subscribeEvents: ({ onSessionEvent }: { onSessionEvent: (event: SessionEvent) => void }) => {
      this.listeners.add(onSessionEvent);
      return () => this.listeners.delete(onSessionEvent);
    },
    executeTurn: (_input: string, _attachments: unknown, options: ExecuteTurnOptions) => {
      assert.ok(options.queryId);
      assert.equal(this.current, undefined);
      this.turnCount++;
      return new Promise<TurnResult>((resolve, reject) => {
        const abort = () => {
          this.current = undefined;
          options.abortSignal?.removeEventListener("abort", abort);
          reject(new Error("synthetic cancellation"));
        };
        this.current = {
          id: `turn-${this.ordinal}-${this.turnCount}`,
          queryId: String(options.queryId),
          resolve,
          reject,
          release: () => options.abortSignal?.removeEventListener("abort", abort),
        };
        options.abortSignal?.addEventListener("abort", abort, { once: true });
        this.emit(SessionEventType.TurnStarted, {
          queryId: this.current.queryId,
          turnNumber: this.turnCount,
          input: "synthetic",
        });
        this.startRequest();
      });
    },
    closeBrowserSession: async () => {
      this.closed++;
    },
  } as unknown as AgentRuntime;

  emit(type: SessionEvent["type"], payload: unknown, turnId = this.current?.id) {
    assert.ok(turnId);
    const event = {
      id: `event-${this.ordinal}-${++this.sequence}`,
      sessionId: this.sessionId,
      type,
      payload,
      turnId,
      timestamp: new Date(),
      traceId: "synthetic-trace",
      sequenceNumber: this.sequence,
    } as SessionEvent;
    for (const listener of this.listeners) listener(event);
  }

  network(type: ModelNetworkStatusEvent["type"], extra: Record<string, unknown> = {}) {
    assert.ok(this.current);
    this.emit(SessionEventType.ModelNetworkStatus, {
      type,
      requestId: this.requestId,
      turnId: this.current.id,
      queryId: this.current.queryId,
      querySource: "workflow_child",
      timestamp: new Date().toISOString(),
      traceId: "synthetic-trace",
      providerId: "synthetic",
      modelId: "synthetic",
      transport: "stream",
      attempt: 1,
      maxAttempts: 0,
      ...extra,
    });
  }

  startRequest() {
    this.requestId = `request-${this.ordinal}-${++this.requestCount}`;
    this.network("model_request_started");
  }

  stream() {
    this.emit(SessionEventType.ModelStreaming, { delta: "x", kind: "text_delta", done: false });
  }

  boundary(tick: number) {
    const phase = (tick + this.ordinal * 7) % 200;
    if (phase === 100) {
      this.network("model_request_completed", { durationMs: 5_000 });
      this.completedRequests++;
      this.emit(SessionEventType.ToolCallStarted, {
        toolCallId: `tool-${tick}`,
        toolName: "Read",
        readOnly: true,
        sideEffectScope: "none",
      });
    } else if (phase === 102) {
      this.emit(SessionEventType.ToolCallResult, {
        toolCallId: `tool-${tick - 2}`,
        result: "synthetic",
      });
      this.startRequest();
    } else if (phase === 180) {
      this.network("model_request_failed", { retryable: true, reason: "network_error" });
      this.network("model_retry_scheduled", {
        reason: "network_error",
        nextAttempt: 2,
        delayMs: 100,
      });
    } else if (phase === 182) {
      this.requestId = `request-${this.ordinal}-${++this.requestCount}`;
      this.network("model_request_queued");
    } else if (phase === 184) {
      this.network("model_request_admitted");
      this.network("model_request_started", { attempt: 2 });
    }
  }

  finish() {
    const turn = this.current;
    assert.ok(turn);
    this.network("model_request_completed", { durationMs: 0 });
    this.completedRequests++;
    this.emit(SessionEventType.TurnComplete, {});
    this.current = undefined;
    turn.release();
    turn.resolve({
      response: "synthetic-result",
      events: [],
      usage: { totalTokens: 7, modelRequestCount: this.requestCount },
    } as unknown as TurnResult);
    return turn.id;
  }
}
