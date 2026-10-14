import assert from "node:assert/strict";
import test from "node:test";
import { createRemoteBrowserNavigationStore } from "./remoteBrowserNavigationStore.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

test("进入标记与设备位置在浏览器重开后保留，草稿覆盖旧会话", () => {
  const storage = memoryStorage();
  const store = createRemoteBrowserNavigationStore(storage);
  assert.equal(store.getState().hasEntered, false);
  store.getState().enter();
  store.getState().remember("device-a", { workspacePath: "/project", taskId: "task-a" });
  store.getState().remember("device-b", { workspacePath: "/other", taskId: "task-b" });
  let reopened = createRemoteBrowserNavigationStore(storage);
  assert.equal(reopened.getState().hasEntered, true);
  assert.equal(reopened.getState().targets["device-a"]?.taskId, "task-a");
  reopened.getState().remember("device-a", { workspacePath: "/project", taskId: null });
  reopened = createRemoteBrowserNavigationStore(storage);
  assert.equal(reopened.getState().targets["device-a"]?.taskId, null);
  assert.equal(reopened.getState().targets["device-b"]?.taskId, "task-b");
});

test("损坏的位置不复活欢迎页，存储拒绝不影响当前页记忆", () => {
  const storage = memoryStorage();
  const store = createRemoteBrowserNavigationStore(storage);
  store.getState().enter();
  const key = [...storage.values.keys()][0]!;
  storage.values.set(key, "broken");
  const reopened = createRemoteBrowserNavigationStore(storage);
  assert.equal(reopened.getState().hasEntered, true);
  assert.deepEqual(reopened.getState().targets, {});
  const unavailable = createRemoteBrowserNavigationStore({
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("blocked");
    },
  });
  assert.doesNotThrow(() =>
    unavailable.getState().remember("device", {
      workspacePath: "/project",
      taskId: "task",
    }),
  );
  assert.equal(unavailable.getState().hasEntered, true);
});
