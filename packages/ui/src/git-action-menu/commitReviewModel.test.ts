import assert from "node:assert/strict";
import test from "node:test";
import {
  selectCommitReviewGroup,
  canSubmitCommitReview,
  advanceCommitReviewPosition,
} from "./commitReviewModel.js";
const review = {
  id: "review",
  mode: "ordered" as const,
  warnings: [],
  groups: [
    {
      id: "A",
      label: "A",
      sessionIds: ["A"],
      dependsOn: [],
      message: "feat: A",
      requiresConfirmation: true,
      files: [],
    },
    {
      id: "B",
      label: "B",
      sessionIds: ["B"],
      dependsOn: ["A"],
      message: "feat: B",
      requiresConfirmation: false,
      files: [],
    },
  ],
};
test("有序候选只提交当前组，人工确认及结束状态控制按钮", () => {
  assert.equal(selectCommitReviewGroup(review, 0)?.id, "A");
  assert.equal(canSubmitCommitReview(review, 0, false), false);
  assert.equal(canSubmitCommitReview(review, 0, true), true);
  assert.equal(selectCommitReviewGroup(review, 1)?.id, "B");
  assert.equal(canSubmitCommitReview(review, 1, false), true);
  assert.equal(canSubmitCommitReview(review, 2, true), false);
  assert.equal(canSubmitCommitReview(null, 0, false), true);
});

test("重复成功响应及旧 review 响应不会跳过下一候选", () => {
  const committed = { id: review.id, groupId: "A" };
  const position = advanceCommitReviewPosition(review, 0, committed);
  assert.equal(position, 1);
  assert.equal(advanceCommitReviewPosition(review, position, committed), 1);
  assert.equal(advanceCommitReviewPosition({ ...review, id: "new-review" }, 0, committed), 0);
  assert.equal(advanceCommitReviewPosition(review, position, { id: review.id, groupId: "B" }), 2);
});
