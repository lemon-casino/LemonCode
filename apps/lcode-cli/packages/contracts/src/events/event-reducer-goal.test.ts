import assert from "node:assert/strict";
import test from "node:test";
import { apply, reduce } from "./event-reducer.js";
import { createSessionEvent, SessionEventType as E } from "./session.events.js";
import type { SessionEvent } from "./session.events.js";
import { createSessionId, createTurnId } from "../interfaces/shared.js";
import { GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE } from "../tools/target.js";

const sessionId = createSessionId("reducer-contract");
const turnId = createTurnId("reducer-contract");

function event(type: SessionEvent["type"], payload: unknown, time = 1): SessionEvent {
  return {
    ...createSessionEvent(type, sessionId, payload, { turnId }),
    timestamp: new Date(time),
  };
}

function initial() {
  return reduce([event(E.SessionCreated, { mode: "build", contextWindow: 100_000 })]);
}

test("goal model results and lifecycle retries keep a single iteration timeline", () => {
  const start = initial();
  const started = apply(
    start,
    event(
      E.TargetCompletionVerification,
      {
        targetId: "goal",
        verificationId: "first",
        status: "started",
        goalIteration: 1,
        anchorAssistantMessageId: "msg_anchor",
        anchorTurnId: turnId,
      },
      2,
    ),
  );
  const failed = apply(
    started,
    event(
      E.TargetCompletionVerification,
      {
        targetId: "goal",
        verificationId: "retry",
        status: "failed_closed",
        goalIteration: 1,
      },
      3,
    ),
  );
  assert.equal(failed.targetCompletionVerificationTimeline.length, 1);
  assert.equal(failed.targetCompletionVerificationTimeline[0]?.startedAt?.getTime(), 2);
  assert.equal(failed.targetCompletionVerificationTimeline[0]?.anchorTurnId, turnId);
  assert.equal(failed.targetCompletionVerifications[0]?.passed, false);
  const verified = apply(
    failed,
    event(
      E.ModelComplete,
      {
        querySource: GOAL_COMPLETION_VERIFICATION_QUERY_SOURCE,
        stopReason: "stop",
        content: '{"passed":true,"reason":"verified"}',
        usage: { inputTokens: 3 },
      },
      4,
    ),
  );
  assert.equal(verified.contextUsed, 0);
  assert.equal(verified.targetCompletionVerifications.length, 2);
  const completed = apply(
    verified,
    event(
      E.TargetCompletionVerification,
      {
        targetId: "goal",
        verificationId: "retry",
        status: "completed",
        goalIteration: 1,
      },
      5,
    ),
  );
  assert.equal(completed.targetCompletionVerifications.length, 2);
  const reset = apply(
    completed,
    event(E.TargetChanged, {
      action: "set",
      previousTarget: { targetID: "goal" },
      target: { targetID: "next" },
    }),
  );
  assert.deepEqual(reset.targetCompletionVerifications, []);
  assert.deepEqual(reset.targetCompletionVerificationTimeline, []);
});
