import assert from "node:assert/strict";
import test from "node:test";
import { QueueSendNowError, queueSendNowFailureMessageId } from "./queueSendNowFailure.js";

test("queue startup failures retain their authority reason instead of implying a model error", () => {
  const cases = [
    ["fault.command.sessionIdleTimeout", "chat.queue.sendNowWaiting"],
    ["guard.queuePromotionBusy", "chat.queue.sendNowBusy"],
    ["guard.queueItemReserved", "chat.queue.sendNowBusy"],
    ["restoreWarning", "chat.queue.sendNowModelUnavailable"],
    ["stale", "chat.queue.sendNowChanged"],
    ["fault.command.executionFailed", "chat.queue.sendNowFailed"],
    ["unknown", "chat.queue.sendNowFailed"],
  ];
  for (const [reason, messageId] of cases) {
    assert.equal(queueSendNowFailureMessageId(new QueueSendNowError(reason)), messageId);
  }
  assert.equal(
    queueSendNowFailureMessageId(new Error("untrusted server message")),
    "chat.queue.sendNowFailed",
  );
});
