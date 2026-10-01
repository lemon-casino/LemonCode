import assert from "node:assert/strict";
import test from "node:test";
import { parseCommitReviewModelOutput, buildCommitReviewPrompt } from "./commitReviewModel.js";
const group = {
  id: "A",
  sessionIds: ["A"],
  label: "会话 A",
  dependsOn: [],
  message: "",
  requiresConfirmation: false,
  files: [],
};
const output = {
  decision: "keep",
  warnings: [],
  messages: [{ id: "A", message: "feat: 增强功能" }],
  mergedMessage: "feat: 合并功能",
};
test("审核 JSON 只接受已冻结的完整候选集合", () => {
  assert.equal(
    parseCommitReviewModelOutput(JSON.stringify(output), [group]).messages[0]!.message,
    "feat: 增强功能",
  );
  for (const messages of [
    [],
    [{ id: "B", message: "feat: 假归属" }],
    [output.messages[0], output.messages[0]],
    [{ id: "A", message: "some prose" }],
  ]) {
    assert.throws(() =>
      parseCommitReviewModelOutput(JSON.stringify({ ...output, messages }), [group]),
    );
  }
  assert.throws(() =>
    parseCommitReviewModelOutput(JSON.stringify({ ...output, patches: [] }), [group]),
  );
  assert.match(
    buildCommitReviewPrompt({ workspacePath: "/repo", groups: [group], warnings: [] }),
    /简体中文/,
  );
});
