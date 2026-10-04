import assert from "node:assert/strict";
import test from "node:test";
import {
  commitReviewNavigationKey,
  useCommitReviewNavigationStore as navigation,
} from "./commitReviewNavigationStore.js";

test("审核打开请求按原项目身份与会话消费，替换旧请求且只消费一次", () => {
  const local = commitReviewNavigationKey("/repo", undefined, "a");
  const remote = commitReviewNavigationKey("/repo", "remote-owner", "a");
  navigation.getState().open(local);
  assert.equal(navigation.getState().consume(remote), false);
  assert.equal(
    navigation.getState().consume(commitReviewNavigationKey("/repo", undefined, "b")),
    false,
  );
  navigation.getState().open(remote);
  assert.equal(navigation.getState().consume(local), false);
  assert.equal(navigation.getState().consume(remote), true);
  assert.equal(navigation.getState().consume(remote), false);
  navigation.getState().open(local);
  navigation.getState().cancel();
  assert.equal(navigation.getState().consume(local), false);
});

test("冲突处理器按项目与会话隔离，旧组件清理不能移除新处理器", async () => {
  const a = commitReviewNavigationKey("/repo", " owner ", "a");
  const b = commitReviewNavigationKey("/repo", "owner", "b");
  assert.equal(a, commitReviewNavigationKey("/repo", "owner", "a"));
  const calls: string[] = [];
  const action = async (id: string) => {
    calls.push(id);
  };
  navigation.getState().registerResolver(a, { token: "old", action });
  navigation.getState().registerResolver(a, { token: "new", action });
  navigation.getState().registerResolver(b, { token: "other", action });
  navigation.getState().removeResolver(a, "old");
  await navigation.getState().resolvers[a]!.action("merge-a");
  assert.deepEqual(calls, ["merge-a"]);
  navigation.getState().removeResolver(a, "new");
  assert.equal(navigation.getState().resolvers[a], undefined);
  assert.equal(navigation.getState().resolvers[b]?.token, "other");
  navigation.getState().removeResolver(b, "other");
});

test("失败草稿只交给匹配会话接收器，旧卸载不能移除新接收器", () => {
  const key = commitReviewNavigationKey("/repo", "owner", "a");
  const calls: string[] = [];
  const action = (value: string) => {
    calls.push(value);
  };
  navigation.getState().registerDraftReceiver(key, { token: "old", action });
  navigation.getState().registerDraftReceiver(key, { token: "new", action });
  navigation.getState().removeDraftReceiver(key, "old");
  assert.equal(
    navigation.getState().transferDraft(commitReviewNavigationKey("/repo", "other", "a"), "wrong"),
    false,
  );
  assert.equal(navigation.getState().transferDraft(key, "diagnostic"), true);
  assert.deepEqual(calls, ["diagnostic"]);
  navigation.getState().removeDraftReceiver(key, "new");
  assert.equal(navigation.getState().transferDraft(key, "late"), false);
});
