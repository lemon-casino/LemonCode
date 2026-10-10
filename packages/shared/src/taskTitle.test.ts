import assert from "node:assert/strict";
import test from "node:test";
import { taskSummaryResultSchema } from "./taskTitle.js";
test("task summary titles are complete Unicode names, never truncated responses", () => {
  assert.equal(
    taskSummaryResultSchema.parse({ title: "清理帮助与问题上报入口" }).title,
    "清理帮助与问题上报入口",
  );
  assert.equal(taskSummaryResultSchema.safeParse({ title: "𠮷".repeat(24) }).success, true);
  for (const value of [
    { title: "𠮷".repeat(25) },
    { title: "标题..." },
    { title: "标题…" },
    { title: "标题\n解释" },
    { title: "" },
    { title: "{}" },
    { title: "名称", extra: "解释" },
  ])
    assert.equal(taskSummaryResultSchema.safeParse(value).success, false);
});
