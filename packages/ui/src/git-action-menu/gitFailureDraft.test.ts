import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGitFailureDraft,
  appendGitFailureDraft,
  worktreeFailureContext,
} from "./gitFailureDraft.js";
import type { WorktreeBinding } from "@lcode/services";

test("诊断保留目标、失败位置和已成功事实，凭据脱敏且大量路径有界", () => {
  const text = buildGitFailureDraft(
    {
      phase: "target-publication",
      sessionId: "session",
      workspacePath: "/source",
      sourceBranch: "task/中文",
      targetBranch: "main",
      targetPath: "/target",
      candidatePath: "/candidate",
      error: "push https://user:secret@example.invalid/repo?token=private rejected; file.ts:12",
      files: Array.from({ length: 10000 }, (_, i) => `file-${i}.ts`),
      completedSteps: ["commit abc succeeded", "branch main pushed"],
      failedSteps: ["tag v1 rejected"],
    },
    "zh-CN",
  );
  for (const value of [
    "main",
    "/target",
    "/candidate",
    "file.ts:12",
    "commit abc succeeded",
    "tag v1 rejected",
    "10000",
  ])
    assert.ok(text.includes(value), value);
  assert.ok(!text.includes("secret"));
  assert.ok(!text.includes("private"));
  assert.ok(text.length < 20000);
  assert.ok(text.includes("先核实"));
});

test("追加诊断保留已有草稿，英文可用且不自动生成执行指令", () => {
  assert.equal(appendGitFailureDraft("existing", "report"), "existing\n\nreport");
  assert.equal(appendGitFailureDraft("", "report"), "report");
  const text = buildGitFailureDraft(
    { phase: "merge", workspacePath: "/repo", error: "conflict" },
    "en-US",
  );
  assert.ok(text.includes("Verify"));
  assert.ok(text.includes("conflict"));
  assert.ok(!text.includes("git reset"));
});

test("共享工作树的失败诊断标记当前会话，不误标为创建工作树的父会话", () => {
  const binding = {
    taskId: "parent",
    branch: "task/shared",
    checkoutPath: "/shared",
  } as WorktreeBinding;
  const context = worktreeFailureContext(binding, null, "failed", "main", "child");
  assert.equal(context.sessionId, "child");
  assert.equal(context.workspacePath, "/shared");
});

test("结构化认证字段和超长验证输出脱敏并明确截断", () => {
  const report = buildGitFailureDraft(
    {
      phase: "validate",
      workspacePath: "/repo",
      error: '{"apiKey": "private-key", "authorization": "Bearer private-auth"}',
      validationResults: [{ command: "check", exitCode: 1, output: "x".repeat(40000) }],
    },
    "zh-CN",
  );
  assert.ok(!report.includes("private-key"));
  assert.ok(!report.includes("private-auth"));
  assert.ok(report.includes('"truncated": true'));
  assert.ok(report.length < 27000);
});

test("步骤和验证条数超限时注明总量及遗漏，不能显示未截断", () => {
  const report = buildGitFailureDraft(
    {
      phase: "publication",
      workspacePath: "/repo",
      error: "failed",
      completedSteps: Array.from({ length: 101 }, (_, i) => `success ${i}`),
      failedSteps: Array.from({ length: 105 }, (_, i) => `failed ${i}`),
      validationResults: Array.from({ length: 12 }, () => ({
        command: "check",
        exitCode: 1,
        output: "failed",
      })),
    },
    "en-US",
  );
  assert.ok(report.includes('"omittedCompletedSteps": 1'));
  assert.ok(report.includes('"omittedFailedSteps": 5'));
  assert.ok(report.includes('"omittedValidationResults": 2'));
  assert.ok(report.includes('"truncated": true'));
});
