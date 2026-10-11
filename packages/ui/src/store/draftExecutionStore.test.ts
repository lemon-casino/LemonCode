import assert from "node:assert/strict";
import test from "node:test";
import { useDraftExecutionStore } from "./draftExecutionStore.js";

test("existing worktree selection survives admission and rejects a second tree while pending", () => {
  const state = useDraftExecutionStore.getState();
  state.choose("tree-project", {
    mode: "worktree",
    existingBinding: { bindingId: "a", bindingOwnerTaskId: "owner" },
  });
  state.begin("tree-project", "create");
  state.choose("tree-project", {
    existingBinding: { bindingId: "b", bindingOwnerTaskId: "other" },
  });
  assert.equal(
    useDraftExecutionStore.getState().drafts["tree-project"]?.existingBinding?.bindingId,
    "a",
  );
  state.reset("tree-project");
});

test("draft selection isolates identities, locks pending and ignores stale settlement", () => {
  const store = useDraftExecutionStore;
  store.getState().choose("remote:a", { mode: "worktree", baseRef: "feature" });
  assert.equal(store.getState().drafts["remote:b"], undefined);
  store.getState().begin("remote:a", "request-1");
  store.getState().choose("remote:a", { mode: "local" });
  assert.equal(store.getState().drafts["remote:a"]?.mode, "worktree");
  store.getState().settle("remote:a", "request-old", "late error");
  assert.equal(store.getState().drafts["remote:a"]?.requestId, "request-1");
  store.getState().settle("remote:a", "request-1", "prepare failed");
  assert.equal(store.getState().drafts["remote:a"]?.error, "prepare failed");
  assert.equal(store.getState().drafts["remote:a"]?.baseRef, "feature");
  store.getState().choose("remote:a", { mode: "local" });
  assert.equal(store.getState().drafts["remote:a"]?.mode, "worktree");
  store.getState().reset("remote:a");
  assert.equal(store.getState().drafts["remote:a"], undefined);
});
