import assert from "node:assert/strict";
import test from "node:test";
import { GitCommitDialogLifecycle } from "./gitCommitDialogLifecycle.js";

test("打开请求不等于可见，effect 重跑不重复打开", () => {
  const owner = new GitCommitDialogLifecycle();
  assert.equal(owner.canAutoOpen("draft-a"), true);
  const id = owner.begin("automatic", "draft-a");
  assert.equal(owner.consumed("draft-a"), false);
  assert.equal(owner.canAutoOpen("draft-a"), false);
  assert.equal(owner.shown(id), true);
  assert.equal(owner.consumed("draft-a"), true);
  assert.equal(owner.shown(id), false);
});

test("关闭和卸载使旧加载与生成结果失效，新请求有独立代次", () => {
  const owner = new GitCommitDialogLifecycle();
  const old = owner.begin("composer");
  owner.close(true);
  assert.equal(owner.isCurrent(old), false);
  const next = owner.begin("composer");
  assert.equal(owner.isCurrent(old), false);
  assert.equal(owner.isCurrent(next), true);
  owner.dispose();
  assert.equal(owner.isCurrent(next), false);
});

test("用户主动关闭消费草稿；失败的未显示请求不伪造消费", () => {
  const owner = new GitCommitDialogLifecycle();
  owner.begin("automatic", "draft-a");
  owner.close();
  assert.equal(owner.consumed("draft-a"), false);
  owner.begin("automatic", "draft-b");
  owner.close(true);
  assert.equal(owner.consumed("draft-b"), true);
  assert.equal(owner.canAutoOpen("draft-b"), false);
  assert.equal(owner.canAutoOpen("draft-c"), true);
});
