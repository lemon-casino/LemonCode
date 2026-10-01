// specs/git-auto-commit-message.md：真实 CLI 投影 -> UI 闸门 -> 弹窗打开判定。
// 运行：pnpm exec tsx --test scripts/git-auto-commit-background-result.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { ProductProjection } from "../apps/lcode-cli/packages/bootstrap/src/lcode-protocol-v4/product-projection.ts";
import {
  advanceAutoGitCommitMessageGate,
  areGitCommitBackgroundWorksSettled,
  createAutoGitCommitMessageGateState,
  resolveLatestCompletedGitCommitMessageTurn,
  shouldAutoOpenGitCommitDialog,
} from "../packages/ui/src/git-action-menu/autoCommitMessage.ts";

for (const taskMode of ["普通任务", "计划任务", "工作流任务"]) {
  test(`${taskMode}：真实未消费结果等待，消费后保留预览不阻止自动弹窗`, () => {
    const projection = new ProductProjection("session-1", "epoch-1");
    let sequenceNumber = 0;
    const apply = (type, payload) =>
      projection.applyEventAtomically(
        {
          id: `event-${++sequenceNumber}`,
          sessionId: "session-1",
          turnId: "turn-1",
          type,
          timestamp: new Date(sequenceNumber),
          traceId: "trace-1",
          sequenceNumber,
          payload,
        },
        () => true,
      );
    apply("turn_started", { turnNumber: 1, input: "修复 Git 自动备份", messageId: "msg-user" });
    const running = advanceAutoGitCommitMessageGate(createAutoGitCommitMessageGateState(), {
      enabled: true,
      scopeKey: "workspace/session",
      phase: projection.getSnapshot().control.phase,
      settled: true,
      completedTurn: null,
    });
    const taskKind = taskMode === "工作流任务" ? "workflow" : "subagent";
    const backgroundTask = { taskId: "work-1", lifecycleId: "life-1", taskKind };
    apply("background_task_started", { ...backgroundTask, status: "running" });
    apply("background_task_completed", { ...backgroundTask, status: "completed" });
    apply("background_task_started", {
      taskId: "preview",
      lifecycleId: "life-preview",
      taskKind: "bash",
      status: "running",
    });
    apply("model_complete", {
      querySource: "main_turn",
      toolCallCount: 0,
      content: "已完成",
      stopReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      fileChanges: { additions: 1, deletions: 0, files: 1, items: [] },
    });
    apply("turn_complete", {
      resultType: "success",
      response: "已完成",
      duration: 100,
      tokenCount: 2,
      toolCallCount: 1,
    });
    const advance = (state) => {
      const snapshot = projection.getSnapshot();
      return advanceAutoGitCommitMessageGate(state, {
        enabled: true,
        scopeKey: "workspace/session",
        phase: snapshot.control.phase,
        settled: areGitCommitBackgroundWorksSettled(snapshot.backgroundWorks),
        completedTurn: resolveLatestCompletedGitCommitMessageTurn(snapshot.rows.window),
      });
    };
    const waiting = advance(running.state);
    assert.equal(waiting.target, undefined);
    assert.equal(waiting.state.armed, true);
    apply("background_task_result_consumed", {
      workId: "work-1",
      lifecycleId: "life-1",
      messageId: "msg-result",
      sourceCommandId: "notification-1",
      delivery: "activeLoop",
    });
    const completed = advance(waiting.state);
    assert.ok(completed.target);
    assert.equal(projection.getSnapshot().backgroundWorks[0]?.status, "running");
    assert.equal(
      shouldAutoOpenGitCommitDialog({
        actionAvailable: true,
        commitDialogOpen: false,
        consumedDraftKey: null,
        draftKey: completed.target.key,
      }),
      true,
    );
    assert.equal(
      shouldAutoOpenGitCommitDialog({
        actionAvailable: true,
        commitDialogOpen: false,
        consumedDraftKey: completed.target.key,
        draftKey: completed.target.key,
      }),
      false,
    );
  });
}
