import assert from "node:assert/strict";
import test from "node:test";
import { childHistoryFixture } from "./child-history-readonly.fixture.js";
import { createConversationV4Gateway } from "./v4-bridge.js";
import { sendPrompt } from "./server-operations.js";

for (const taskType of ["subagent_child", "workflow_child"] as const) {
  test(`${taskType} generic input is rejected before inbox/ledger/history while workflow controls stay separate`, async () => {
    const f = childHistoryFixture();
    f.stored.taskType = taskType;
    let writes = 0;
    f.store.saveSessionEntry = async () => {
      writes++;
    };
    const gateway = createConversationV4Gateway(f.context);
    try {
      const ack = await gateway.handleCommand({
        type: "sendText",
        sessionId: f.sessionId,
        commandId: "blocked-input",
        clientId: "fixture",
        issuedAt: 1,
        payload: { text: "must not execute" },
      });
      assert.equal(ack.status, "rejected");
      assert.equal(ack.reasonCode, "guard.subagentReadOnly");
      assert.equal(writes, 0);
      assert.equal(f.appCreations(), 0);
      assert.equal(f.context.sessions.size, 0);
    } finally {
      gateway.dispose();
    }
  });

  test(`${taskType} legacy prompt is denied using metadata before requiring a runtime`, async () => {
    const f = childHistoryFixture();
    f.stored.taskType = taskType;
    await assert.rejects(
      sendPrompt(f.context, { sessionId: f.sessionId, content: "must not execute" }),
      (error: unknown) =>
        (error as { data?: { reasonCode?: string } }).data?.reasonCode === "guard.subagentReadOnly",
    );
    assert.equal(f.appCreations(), 0);
  });

  test(`${taskType} delivery overrides and continuation controls cannot bypass read-only admission`, async () => {
    const f = childHistoryFixture();
    f.stored.taskType = taskType;
    let writes = 0;
    f.store.saveSessionEntry = async () => {
      writes++;
    };
    const gateway = createConversationV4Gateway(f.context);
    const cases = [
      ...["startNow", "queue", "guide"].map((requestedDelivery) => ({
        type: "sendText",
        payload: { text: "fixture", requestedDelivery },
      })),
      { type: "compact", payload: {} },
      { type: "resumeGoal", payload: {} },
      { type: "retryTurn", payload: { target: { rowId: 1, entityId: "fixture" } } },
      {
        type: "switchModelConfig",
        payload: { provider: "fixture", model: "fixture", thought: "high" },
      },
      { type: "setFollowupMode", payload: { mode: "guide" } },
      { type: "setAutoDrain", payload: { autoDrain: true } },
    ];
    try {
      for (const [index, command] of cases.entries()) {
        const ack = await gateway.handleCommand({
          ...command,
          sessionId: f.sessionId,
          commandId: `blocked-${index}`,
          clientId: "fixture",
          issuedAt: 1,
          baseRevision: 1,
          baseLogEpoch: "fixture",
        });
        assert.equal(ack.status, "rejected", `${command.type}: ${JSON.stringify(ack)}`);
        assert.equal(ack.reasonCode, "guard.subagentReadOnly", command.type);
      }
      assert.equal(writes, 0);
      assert.equal(f.appCreations(), 0);
    } finally {
      gateway.dispose();
    }
  });
}
