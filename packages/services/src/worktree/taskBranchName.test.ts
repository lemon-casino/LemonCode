import assert from "node:assert/strict";
import test from "node:test";
import { taskBranchName } from "./domain/taskBranchName.js";

test("task branch names preserve Chinese and normalize unsafe ref text", () => {
  assert.equal(taskBranchName("修复模型切换"), "lcode/task-修复模型切换");
  assert.equal(
    taskBranchName("  修复 模型/切换：问题\n忽略第二行  "),
    "lcode/task-修复-模型-切换-问题",
  );
  assert.equal(
    taskBranchName("修复..模型@{测试}.lock~^:?*[]\\故障"),
    "lcode/task-修复-模型-测试-lock-故障",
  );
  assert.equal(taskBranchName("优化 🚀 设置"), "lcode/task-优化-设置");
  assert.equal(taskBranchName("ＡＢＣ 设置"), "lcode/task-ABC-设置");
});

test("task names are bounded by Unicode characters and have a readable fallback", () => {
  assert.equal(taskBranchName("𠀀".repeat(40)), `lcode/task-${"𠀀".repeat(24)}`);
  for (const name of [undefined, "", "   ", "🧪 ../@{}[]", "\n修复"])
    assert.equal(taskBranchName(name), "lcode/task-新会话");
});
