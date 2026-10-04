import assert from "node:assert/strict";
import test from "node:test";
import { findBranchWorktree } from "./branchOccupancy.js";

test("工作树匹配同时核对分支与路径，Windows 分隔符兼容且 POSIX 大小写敏感", () => {
  const bindings = [
    { branch: "feature", checkoutPath: "C:\\workspace\\feature" },
    { branch: "other", checkoutPath: "/repo/Feature" },
  ];
  assert.equal(findBranchWorktree(bindings, "feature", "c:/workspace/FEATURE"), bindings[0]);
  assert.equal(findBranchWorktree(bindings, "wrong", "c:/workspace/feature"), undefined);
  assert.equal(findBranchWorktree(bindings, "other", "/repo/Feature"), bindings[1]);
  assert.equal(findBranchWorktree(bindings, "other", "/repo/feature"), undefined);
  assert.equal(findBranchWorktree(bindings, "feature", undefined), undefined);
});
