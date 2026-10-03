import assert from "node:assert/strict";
import test from "node:test";
import { commitMergeState } from "./commitMergeState.js";

test("历史失败和取消记录不隐藏来源范围或锁住新的提交", () => {
  for (const status of ["cancelled", "failed", "source-commit-failed", "published"] as const) {
    const state = commitMergeState({ id: "old", status }, null);
    assert.equal(state.showMerge, false);
    assert.equal(state.sourceLocked, false);
    assert.equal(
      commitMergeState({ id: "old", status }, { operationId: "old", source: false }).showMerge,
      true,
    );
  }
});

test("活动合并回看来源仍只读；其它操作的浏览选择不影响当前阶段", () => {
  for (const status of [
    "preparing",
    "committing-source",
    "conflicted",
    "awaiting-review",
    "validating",
    "validation-failed",
    "ready",
    "publishing",
  ] as const) {
    assert.deepEqual(commitMergeState({ id: "current", status }, null), {
      showMerge: true,
      sourceLocked: true,
    });
    assert.deepEqual(
      commitMergeState({ id: "current", status }, { operationId: "current", source: true }),
      { showMerge: false, sourceLocked: true },
    );
    assert.equal(
      commitMergeState({ id: "current", status }, { operationId: "old", source: true }).showMerge,
      true,
    );
  }
  assert.deepEqual(commitMergeState(undefined, null), { showMerge: false, sourceLocked: false });
});
