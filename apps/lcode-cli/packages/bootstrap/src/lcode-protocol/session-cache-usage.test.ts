import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@lcode/contracts";
import { observeSessionDebug, readSessionDebug } from "./session-debug.js";

test("session Token detail retains reported write, explicit zero and unknown without replay duplication", () => {
  const record = { app: { sessionId: "fixture-session" } };
  for (const [index, write] of [30, 0, undefined].entries()) {
    const event = {
      id: `event-${index}`,
      sessionId: "fixture-session",
      traceId: "fixture-trace",
      timestamp: new Date(1000),
      sequenceNumber: index,
      type: SessionEventType.ModelNetworkStatus,
      payload: {
        type: "model_request_completed",
        requestId: `request-${index}`,
        timestamp: new Date(1000).toISOString(),
        providerId: "fixture",
        modelId: "fixture-model",
        providerKind: "openai-compatible",
        transport: "http",
        querySource: "main_turn",
        attempt: 1,
        maxAttempts: 1,
        durationMs: 100,
        usage: {
          inputTokens: 100,
          outputTokens: 5,
          totalTokens: 105,
          cacheReadTokens: 40,
          ...(write === undefined ? {} : { cacheWriteTokens: write }),
        },
      },
    } as unknown as SessionEvent;
    observeSessionDebug(record, event);
    observeSessionDebug(record, event);
    const debug = readSessionDebug(record);
    assert.equal(debug.rounds.length, index + 1);
    assert.equal(debug.rounds[index]!.usage.cachedWriteInputTokens, write);
    assert.equal(debug.rounds[index]!.usage.totalTokens, 105);
  }
});
