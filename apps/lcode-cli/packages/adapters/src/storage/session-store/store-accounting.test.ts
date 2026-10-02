import assert from "node:assert/strict";
import test from "node:test";
import type { ProjectId, SessionId, TurnId } from "@lcode/contracts";
import { createSqliteSessionStore } from "../session-store.js";

test("goal accounting retains stale-run guards, defaults and recovery timing", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionID = "goal-session" as SessionId;
  try {
    await store.createSession({
      id: sessionID,
      projectID: "project" as ProjectId,
      directory: "fixture",
      slug: "goal",
      title: "goal",
      version: "1",
    });
    const target = await store.setTarget({ sessionID, objective: "fixture", tokenBudget: 10 });
    assert.equal(target.status, "active");
    await store.startTargetRun({
      sessionID,
      targetID: target.targetID,
      inputID: "input",
      startedAtMs: 1_000,
    });
    await store.heartbeatTargetRun({
      sessionID,
      targetID: target.targetID,
      inputID: "input",
      seenAtMs: 3_001,
    });
    const stale = await store.finishTargetRun({
      sessionID,
      targetID: target.targetID,
      inputID: "stale-input",
      endedAtMs: 9_000,
      tokensUsedDelta: 20,
    });
    assert.equal(stale?.tokensUsed, 0);
    const recovered = await store.recoverInterruptedTargetRun({ sessionID });
    assert.equal(recovered?.status, "paused");
    assert.equal(recovered?.timeUsedSeconds, 3);
    assert.equal(recovered?.activeInputId, null);
    await store.updateTargetStatus({ sessionID, status: "active" });
    const accounted = await store.accountTargetUsage({
      sessionID,
      targetID: target.targetID,
      tokensUsedDelta: 10,
    });
    assert.equal(accounted?.status, "budget_limited");
    const unchanged = await store.updateTargetSummaryTitle({
      sessionID,
      targetID: "stale-target",
      summaryTitle: "must not apply",
    });
    assert.equal(unchanged?.targetID, target.targetID);
    assert.equal((await store.readTarget({ sessionID }))?.summaryTitle, null);
    assert.equal(await store.clearTarget({ sessionID }), true);
    assert.equal(await store.clearTarget({ sessionID }), false);
  } finally {
    store.close();
  }
});

test("usage writes, queries and pruning retain serialization and accounting", async () => {
  const store = createSqliteSessionStore({ dbPath: ":memory:" });
  const sessionID = "usage-session" as SessionId;
  const startedAt = Date.now();
  try {
    await store.createSession({
      id: sessionID,
      projectID: "project" as ProjectId,
      directory: "fixture",
      slug: "usage",
      title: "usage",
      version: "1",
    });
    for (const [index, inputTokens, outputTokens] of [
      [0, 10, 2],
      [1, 15, 3],
    ] as const) {
      await store.recordModelUsage({
        id: `usage-${index}`,
        logicalRequestId: `request-${index}`,
        sessionID,
        querySource: "main_turn",
        providerId: "fixture",
        modelId: "model",
        status: "completed",
        startedAt: startedAt + index,
        inputTokens,
        outputTokens,
        cacheReadInputTokens: 5,
        rawUsage: { fixture: true },
        providerMetadata: { fixture: true },
      });
    }
    await store.upsertTurnUsage({
      sessionID,
      turnID: "turn" as TurnId,
      status: "completed",
      startedAt,
      durationMs: 100,
      modelRequestCount: 2,
    });
    await store.upsertToolUsage({
      id: "tool",
      sessionID,
      toolCallID: "call",
      toolName: "read",
      status: "completed",
      startedAt,
      outputBytes: 10,
    });
    await store.upsertToolUsage({
      id: "tool",
      sessionID,
      toolCallID: "call",
      toolName: "unknown",
      status: "running",
      startedAt: startedAt + 1,
      outputBytes: 1,
    });
    const task = await store.queryTaskUsage({ sessionID });
    assert.equal(task.inputTokens, 15);
    assert.equal(task.outputTokens, 5);
    assert.equal(task.totalTokens, 20);
    assert.deepEqual(task.inputBaselineBySource, { main_turn: 15 });
    const app = await store.queryAppUsage({
      since: startedAt - 1,
      until: startedAt + 10,
      tzOffsetMs: 0,
    });
    assert.equal(app.totals.totalTokens, 30);
    assert.equal(app.totals.modelRequestCount, 2);
    assert.equal(app.turnTotals.longestSessionMs, 100);
    assert.equal(app.tools[0]?.toolName, "read");
    assert.equal(app.toolTotals.toolCallCount, 1);
    assert.equal(app.days.length, 1);
    await store.pruneUsage({ beforeTime: startedAt + 20 });
    const counts = store.debugCounts();
    assert.equal(counts.modelUsage, 0);
    assert.equal(counts.turnUsage, 0);
    assert.equal(counts.toolUsage, 0);
  } finally {
    store.close();
  }
});
