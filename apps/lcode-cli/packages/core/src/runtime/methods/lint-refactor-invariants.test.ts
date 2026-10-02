import assert from "node:assert/strict";
import test from "node:test";
import { AgentRuntime } from "../agent-runtime.js";
import { createSessionId, createRootTraceContext, SessionEventType } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactBoundaryPayload, MessageId, TurnId } from "../deps.js";
import { appendEvent, createEvent } from "./events.js";
import { persistCompactSummary } from "./compact-persistence.js";
import { executeTurn, executeTurnCommand } from "./turn.js";
import { compactActiveConversation } from "./compact-active.js";
import {
  beginActiveTurn,
  reservePendingInputById,
  releasePendingInputReservation,
  steerTurn,
} from "./steering.js";
import { forkStableConversationAtMessage } from "./session-fork.js";
import { applyWorkspaceFileRewind } from "./file-rewind.js";
import { runModelTextRequest } from "./model.js";

const traceContext = createRootTraceContext();

test("runtime installs the original callable entrypoints without wrappers or arity changes", () => {
  const prototype = AgentRuntime.prototype as unknown as Record<string, unknown>;
  const methods = [
    ["executeTurn", executeTurn, 3],
    ["executeTurnCommand", executeTurnCommand, 4],
    ["steerTurn", steerTurn, 1],
    ["beginActiveTurn", beginActiveTurn, 5],
    ["reservePendingInputById", reservePendingInputById, 1],
    ["releasePendingInputReservation", releasePendingInputReservation, 1],
    ["forkStableConversationAtMessage", forkStableConversationAtMessage, 1],
    ["applyWorkspaceFileRewind", applyWorkspaceFileRewind, 0],
    ["compactActiveConversation", compactActiveConversation, 3],
    ["runModelTextRequest", runModelTextRequest, 1],
    ["appendEvent", appendEvent, 2],
    ["persistCompactSummary", persistCompactSummary, 6],
  ] as const;
  for (const [name, method, arity] of methods) {
    assert.equal(prototype[name], method, name);
    assert.equal(method.length, arity, name);
  }
});

test("event append publishes the stored sequence only after durable persistence", async () => {
  const order: string[] = [];
  const runtime = {
    sessionId: createSessionId(),
    eventStore: {
      append: async (event: ReturnType<typeof createEvent>) => {
        order.push("event-store");
        return { ...event, sequenceNumber: 17 };
      },
    },
    sessionStore: {
      saveSessionInput: async () => {
        order.push("durable-input");
      },
    },
    notifyEventSinks: async (event: ReturnType<typeof createEvent>) => {
      assert.equal(event.sequenceNumber, 17);
      order.push("sink");
    },
  } as unknown as AgentRuntimeInternal;
  const event = createEvent.call(
    runtime,
    SessionEventType.TurnSteerQueued,
    { pendingInputId: "queued-1", input: "queued input" },
    traceContext,
  );
  await appendEvent.call(runtime, event, traceContext);
  assert.deepEqual(order, ["event-store", "durable-input", "sink"]);
});

test("pending input reservation restores its owner when persistence throws a falsy error", async () => {
  const runtime = {
    activeTurn: {
      pendingInputs: [{ id: "pending-1", turnId: "turn-1" as TurnId }],
    },
    pendingInputReservations: new Map<string, string>(),
    sessionId: createSessionId(),
    appendEvent: async () => {
      throw false;
    },
  } as unknown as AgentRuntimeInternal;
  const options = { pendingInputId: "pending-1", reservationId: "lease-1", traceContext };
  await assert.rejects(reservePendingInputById.call(runtime, options), (error) => error === false);
  assert.equal(runtime.pendingInputReservations.size, 0);

  runtime.pendingInputReservations.set("pending-1", "lease-1");
  await assert.rejects(
    releasePendingInputReservation.call(runtime, options),
    (error) => error === false,
  );
  assert.equal(runtime.pendingInputReservations.get("pending-1"), "lease-1");
});

test("compact summary rollback retains falsy primary errors when cleanup also fails", async () => {
  const removed: MessageId[] = [];
  const messageID = "summary-1" as MessageId;
  const runtime = {
    sessionId: createSessionId(),
    config: {},
    getSessionModelSelection: () => undefined,
    getTools: () => [],
    persistMessage: async () => {},
    persistPart: async () => {
      throw 0;
    },
    sessionStore: {
      removeMessage: async (input: { messageID: MessageId }) => {
        removed.push(input.messageID);
        throw new Error("cleanup failed");
      },
    },
  } as unknown as AgentRuntimeInternal;
  await assert.rejects(
    persistCompactSummary.call(
      runtime,
      messageID,
      "summary content",
      "summary",
      {} as CompactBoundaryPayload,
      traceContext,
    ),
    (error) => error === 0,
  );
  assert.deepEqual(removed, [messageID]);
});
