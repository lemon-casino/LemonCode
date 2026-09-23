import assert from "node:assert/strict";
import test from "node:test";

import {
  createPipSessionCoordinator,
  normalizePipSessionEvent,
  normalizePipSessionSnapshot,
} from "./pip-session-coordinator.js";
import { encodeRgbPng } from "./png.js";

function createPresenter() {
  const calls = [];
  return {
    calls,
    async show(capture) {
      calls.push(["show", capture.frameId]);
    },
    async hide() {
      calls.push(["hide"]);
    },
    async dispose() {
      calls.push(["dispose"]);
    },
  };
}

const started = (sequenceNumber = 1) => ({
  kind: "turn-started",
  sessionId: "session-a",
  turnId: "turn-a",
  sequenceNumber,
  eventId: `start-${sequenceNumber}`,
});

const focus = (revision = 1, sessionId = "session-a") => ({
  kind: "focus-changed",
  sessionId,
  revision,
  sourceWindowId: "window-1",
  eventId: `focus-${revision}`,
});

const capture = (frameId = "frame-a") => ({
  sessionId: "session-a",
  turnId: "turn-a",
  frameId,
  mimeType: "image/png",
  data: encodeRgbPng(2, 1, Buffer.alloc(6)).toString("base64"),
  width: 2,
  height: 1,
  title: "Example",
});

test("strict event and snapshot normalization reject unknown fields and invalid clocks", () => {
  assert.equal(normalizePipSessionEvent({ ...started(), extra: true }), undefined);
  assert.equal(normalizePipSessionEvent({ ...focus(), revision: -1 }), undefined);
  assert.equal(
    normalizePipSessionSnapshot({ turns: [started()], focus: focus() })?.turns.length,
    1,
  );
  assert.equal(normalizePipSessionSnapshot({ turns: [started(), started(2)] }), undefined);
});

test("coordinator only shows a trusted capture when focus and an open turn match", async () => {
  const presenter = createPresenter();
  const coordinator = createPipSessionCoordinator({ presenter });
  assert.deepEqual(await coordinator.applyEvent(focus()), { applied: true });
  assert.deepEqual(await coordinator.applyEvent(started()), { applied: true });
  assert.deepEqual(await coordinator.bindCapture(capture()), { accepted: true, pending: false });
  assert.deepEqual(presenter.calls, [["show", "frame-a"]]);

  assert.deepEqual(
    await coordinator.applyEvent({
      kind: "turn-ended",
      sessionId: "session-a",
      turnId: "turn-a",
      sequenceNumber: 2,
      eventId: "end-2",
      outcome: "completed",
    }),
    { applied: true },
  );
  assert.deepEqual(presenter.calls, [["show", "frame-a"], ["hide"]]);
  await coordinator.dispose();
  assert.deepEqual(presenter.calls.at(-1), ["dispose"]);
});

test("stale clocks, duplicate ids and mismatched terminal events are fenced", async () => {
  const coordinator = createPipSessionCoordinator({ presenter: createPresenter() });
  await coordinator.applyEvent(started(4));
  assert.deepEqual(await coordinator.applyEvent(started(4)), {
    applied: false,
    reason: "duplicate-event",
  });
  assert.deepEqual(await coordinator.applyEvent({ ...started(3), eventId: "older" }), {
    applied: false,
    reason: "stale-sequence",
  });
  assert.deepEqual(
    await coordinator.applyEvent({
      kind: "turn-ended",
      sessionId: "session-a",
      turnId: "other-turn",
      sequenceNumber: 5,
      eventId: "wrong-end",
    }),
    { applied: false, reason: "turn-mismatch" },
  );
  assert.deepEqual(
    await coordinator.applyEvent({ ...started(4), sequenceNumber: 4, eventId: "late" }),
    {
      applied: false,
      reason: "stale-sequence",
    },
  );
  await coordinator.applyEvent(focus(5));
  assert.deepEqual(await coordinator.applyEvent({ ...focus(4), eventId: "older-focus" }), {
    applied: false,
    reason: "stale-revision",
  });
});

test("capture may wait briefly for a delayed turn-started and expires deterministically", async () => {
  let timestamp = 100;
  const presenter = createPresenter();
  const coordinator = createPipSessionCoordinator({
    presenter,
    now: () => timestamp,
    pendingCaptureTtlMs: 20,
  });
  await coordinator.applyEvent(focus());
  assert.deepEqual(await coordinator.bindCapture(capture("pending")), {
    accepted: true,
    pending: true,
  });
  await coordinator.applyEvent(started());
  assert.deepEqual(presenter.calls, [["show", "pending"]]);

  await coordinator.applyEvent({ ...focus(2, null), eventId: "blur" });
  await coordinator.applyEvent({ ...started(2), turnId: "turn-b", eventId: "start-b" });
  assert.deepEqual(await coordinator.bindCapture({ ...capture("expired"), turnId: "turn-c" }), {
    accepted: false,
    reason: "turn-mismatch",
  });
  await coordinator.applyEvent({
    kind: "session-closed",
    sessionId: "session-a",
    sequenceNumber: 3,
    eventId: "closed",
  });
  assert.deepEqual(await coordinator.bindCapture({ ...capture("will-expire"), turnId: "turn-d" }), {
    accepted: true,
    pending: true,
  });
  timestamp = 121;
  await coordinator.applyEvent({ ...started(4), turnId: "turn-d", eventId: "start-d" });
  assert.equal(coordinator.inspect().sessions[0].frameId, undefined);
});

test("authenticated reconnect snapshot consumes a matching unexpired pending capture", async () => {
  const presenter = createPresenter();
  const coordinator = createPipSessionCoordinator({ presenter });
  assert.deepEqual(await coordinator.bindCapture(capture("snapshot-pending")), {
    accepted: true,
    pending: true,
  });

  assert.deepEqual(await coordinator.applySnapshot({ turns: [started()], focus: focus() }), {
    applied: true,
  });
  assert.deepEqual(presenter.calls, [["show", "snapshot-pending"]]);
  assert.deepEqual(coordinator.inspect().pendingSessions, []);
  assert.equal(coordinator.inspect().sessions[0].frameId, "snapshot-pending");
});

test("retained capture budget is shared by sessions and pending captures", async () => {
  const sample = capture("pending-a");
  const coordinator = createPipSessionCoordinator({
    presenter: createPresenter(),
    maxRetainedCaptureBytes: Buffer.from(sample.data, "base64").length,
  });
  assert.deepEqual(await coordinator.bindCapture(sample), {
    accepted: true,
    pending: true,
  });

  await coordinator.applyEvent({
    ...started(),
    sessionId: "session-b",
    turnId: "turn-b",
    eventId: "start-b",
  });
  assert.deepEqual(
    await coordinator.bindCapture({
      ...capture("frame-b"),
      sessionId: "session-b",
      turnId: "turn-b",
    }),
    { accepted: false, reason: "capture-capacity" },
  );

  await coordinator.applyEvent(started());
  assert.deepEqual(await coordinator.bindCapture(capture("replacement-a")), {
    accepted: true,
    pending: false,
  });
  assert.deepEqual(
    await coordinator.bindCapture({
      ...capture("pending-c"),
      sessionId: "session-c",
      turnId: "turn-c",
    }),
    { accepted: false, reason: "capture-capacity" },
  );
  assert.deepEqual(coordinator.inspect().pendingSessions, []);
  assert.equal(
    coordinator.inspect().sessions.find(({ sessionId }) => sessionId === "session-a")?.frameId,
    "replacement-a",
  );
});

test("capture rejects non-canonical base64, fake PNG and IHDR dimension mismatches", async () => {
  const coordinator = createPipSessionCoordinator({ presenter: createPresenter() });
  assert.deepEqual(await coordinator.bindCapture({ ...capture(), data: "***=" }), {
    accepted: false,
    reason: "invalid-capture",
  });
  assert.deepEqual(
    await coordinator.bindCapture({
      ...capture(),
      data: Buffer.from("not a png").toString("base64"),
    }),
    { accepted: false, reason: "invalid-capture" },
  );
  assert.deepEqual(await coordinator.bindCapture({ ...capture(), width: 3 }), {
    accepted: false,
    reason: "invalid-capture",
  });
});

test("authenticated reconnect snapshot replaces lifecycle facts while preserving matching capture", async () => {
  const presenter = createPresenter();
  const coordinator = createPipSessionCoordinator({ presenter });
  await coordinator.applyEvent(started());
  await coordinator.applyEvent(focus());
  await coordinator.bindCapture(capture());
  assert.deepEqual(await coordinator.applySnapshot({ turns: [started(9)], focus: focus(9) }), {
    applied: true,
  });
  assert.equal(coordinator.inspect().visible?.frameId, "frame-a");
  assert.equal(coordinator.inspect().sessions[0].lastSequence, 9);
});

test("presenter failure does not commit a visible state or acknowledge the event", async () => {
  const presenter = createPresenter();
  presenter.show = async () => {
    throw new Error("presenter failed");
  };
  const coordinator = createPipSessionCoordinator({ presenter });
  await coordinator.applyEvent(started());
  await coordinator.applyEvent(focus());
  await assert.rejects(coordinator.bindCapture(capture()), /presenter failed/u);
  assert.equal(coordinator.inspect().visible, undefined);
  assert.equal(coordinator.inspect().sessions[0].frameId, undefined);
});
