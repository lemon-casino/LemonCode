import assert from "node:assert/strict";
import test from "node:test";
import { integrationOutcome } from "./integrationOutcome.js";
import type { WorktreeIntegration } from "@lcode/services";

test("历史空合并只根据已冻结相同 HEAD 判断，无 diff 不能猜测仅历史变化", () => {
  const operation = {
    status: "published",
    targetHead: "a",
    candidateHead: "a",
    diff: "",
  } as WorktreeIntegration;
  assert.equal(integrationOutcome(operation), "already-contained");
  assert.equal(integrationOutcome({ ...operation, candidateHead: "b" }), "unknown");
  assert.equal(integrationOutcome({ ...operation, status: "awaiting-review" }), "unknown");
});

test("仅历史、二进制内容和无需合并分别采用 owner 结果", () => {
  const operation = {
    mergeResult: {
      kind: "history-only",
      changedFiles: 0,
      sourceCommitCount: 1,
      uncommittedFileCount: 0,
    },
  } as WorktreeIntegration;
  assert.equal(integrationOutcome(operation), "history-only");
  assert.equal(
    integrationOutcome({
      ...operation,
      mergeResult: { ...operation.mergeResult!, kind: "content", changedFiles: 1 },
      diff: "",
    }),
    "content",
  );
});
