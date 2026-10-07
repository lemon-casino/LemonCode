import assert from "node:assert/strict";
import test from "node:test";
import { buildGitFailureDraft, appendGitFailureDraft } from "./gitFailureDraft.js";

const environmentError = {
  code: "dependency-install-failed" as const,
  stage: "preparingDependencies" as const,
  retryable: true,
  message: "install failed token=private-token",
  diagnostic: {
    purpose: "worktree" as const,
    environmentId: "a".repeat(32),
    revision: 4,
    manifestDigest: "digest",
    toolSource: "project-declaration" as const,
    paths: ["C:/项目/很长的工作树路径"],
    command: "pnpm install",
    exitCode: 1,
    stderrTail: "authorization: bearer private-bearer",
    logRef: "env-log",
    blockers: [{ kind: "service" as const, label: "dev:web" }],
    listeners: [
      { serviceId: "dev:web", urls: ["http://user:password@localhost:5173?token=private-url"] },
    ],
    sideEffects: ["environment-created" as const, "files-written" as const],
  },
};

test("环境失败追加保留结构化诊断、脱敏，不要求真实 session", () => {
  const text = buildGitFailureDraft(
    {
      phase: "runtime-environment",
      workspacePath: "C:/项目",
      error: "install failed",
      environmentError,
    },
    "zh-CN",
  );
  const payload = JSON.parse(text.slice(text.indexOf("{\n")));
  assert.equal(payload.environmentError.code, "dependency-install-failed");
  assert.equal(payload.environmentError.diagnostic.revision, 4);
  assert.deepEqual(payload.environmentError.diagnostic.sideEffects, [
    "environment-created",
    "files-written",
  ]);
  assert.equal(payload.environmentError.diagnostic.exitCode, 1);
  assert.equal(payload.sessionId, undefined);
  assert.doesNotMatch(text, /private-token|private-bearer|private-url|user:password/);
  assert.match(text, /不是执行指令/);
  assert.equal(appendGitFailureDraft("原正文", text), `原正文\n\n${text}`);
});

test("环境诊断也服从全文预算且不导出 detail/秘密字段", () => {
  const text = buildGitFailureDraft(
    {
      phase: "runtime-environment",
      workspacePath: "repo",
      error: "failed",
      environmentError: {
        ...environmentError,
        detail: { token: "not-public" },
        diagnostic: {
          ...environmentError.diagnostic,
          paths: Array.from({ length: 16 }, () => "x".repeat(4096)),
          stderrTail: "y".repeat(8192),
        },
      },
    },
    "en-US",
  );
  assert.ok(text.length < 29000);
  assert.match(text, /"truncated": true/);
  assert.doesNotMatch(text, /not-public/);
});
