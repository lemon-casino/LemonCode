import assert from "node:assert/strict";
import test from "node:test";
import { commandPayloadSchemas } from "./command.js";
import { reduceWorkflowRunsState } from "./workflow-runs-reducer.js";

test("ask pause and retry project the current attempt and discard stale progress", () => {
  let state: ReturnType<typeof reduceWorkflowRunsState> | undefined;
  const send = (sequence: number, eventType: string, instance: object, extra = {}) => {
    const next = reduceWorkflowRunsState(state ?? undefined, {
      runId: "run-1",
      sequence,
      eventType,
      payload: { instance, ...extra },
    });
    if (next !== null) state = next;
  };
  const original = { siteId: "ask#1", ordinal: 1 };
  send(1, "node-queued", original, { kind: "ask" });
  send(2, "node-dispatched", original);
  send(3, "node-paused", original);
  assert.equal(state?.runs[0]?.nodes[0]?.phase, "paused");
  send(4, "node-retried", { ...original, attempt: 2 });
  assert.equal(state?.runs[0]?.nodes[0]?.attempt, 2);
  assert.equal(state?.runs[0]?.nodes[0]?.phase, "queued");
  send(5, "node-progress", original, { turn: 4, toolCalls: 3 });
  send(6, "node-settled", original, { outcome: "ok" });
  assert.equal(state?.runs[0]?.nodes[0]?.phase, "queued");
  assert.equal(state?.runs[0]?.nodes[0]?.turn, undefined);
});

test("task supplement accepts bounded images and rejects invalid image refs", () => {
  const image = {
    ref: "zcode-artifact://image-1",
    fileName: "paste.png",
    mime: "image/png",
    bytes: 40,
  };
  const retry = {
    runId: "run-1",
    siteId: "ask#1",
    ordinal: 1,
    attempt: 1,
    action: "retry",
    attachments: [image],
  };
  const revise = { runId: "run-1", siteId: "ask#1", ordinal: 1, attachments: [image] };
  assert.equal(commandPayloadSchemas.controlWorkflowAsk.safeParse(retry).success, true);
  assert.equal(commandPayloadSchemas.reviseWorkflowAsk.safeParse(revise).success, true);
  assert.equal(
    commandPayloadSchemas.controlWorkflowAsk.safeParse({
      ...retry,
      attachments: Array(9).fill(image),
    }).success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.reviseWorkflowAsk.safeParse({
      ...revise,
      attachments: [{ ...image, mime: "text/plain" }],
    }).success,
    false,
  );
  assert.equal(
    commandPayloadSchemas.reviseWorkflowAsk.safeParse({
      ...revise,
      attachments: [{ ...image, ref: "x".repeat(4097) }],
    }).success,
    false,
  );
});
