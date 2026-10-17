import assert from "node:assert/strict";
import { test } from "node:test";
import type { DatabaseStartupState } from "@lcode/shared";
import { DatabaseStartupAdmission } from "../src/renderer/src/databaseStartupAdmission.js";
import { StartupAnimationState } from "../src/renderer/src/startup/animationState.js";

const state = (
  startupId: string,
  sequence: number,
  phase: DatabaseStartupState["phase"],
): DatabaseStartupState => ({
  schemaVersion: 1,
  startupId,
  sequence,
  phase,
  attemptId: startupId,
  startedAt: 1,
  updatedAt: 1,
  disk: [],
});
const port = () => ({ close() {} }) as MessagePort;

test("ready 与端口先后顺序不改变同代准入", () => {
  for (const readyFirst of [true, false]) {
    const admission = new DatabaseStartupAdmission();
    const channel = port();
    if (readyFirst) admission.acceptState(state("current", 1, "ready"));
    admission.acceptPort({ databaseStartupId: "current" }, channel);
    if (!readyFirst) {
      assert.equal(admission.takeReadyPort(), undefined);
      admission.acceptState(state("current", 1, "ready"));
    }
    assert.equal(admission.takeReadyPort(), channel);
    assert.equal(admission.takeReadyPort(), undefined);
  }
});

test("跳过和 watchdog 不把旧代 ready 与新代端口拼成成功", () => {
  for (const reason of ["skip", "watchdog", "media-error"] as const) {
    const admission = new DatabaseStartupAdmission();
    admission.acceptState(state("old", 1, "ready"));
    const channel = port();
    admission.acceptPort({ databaseStartupId: "new" }, channel);
    const animation = new StartupAnimationState("cinematic");
    animation.finish(reason);
    assert.equal(admission.takeReadyPort(), undefined);
    admission.acceptState(state("new", 1, "failed"));
    assert.equal(admission.takeReadyPort(), undefined);
    assert.equal(admission.acceptState(state("new", 0, "ready")), false);
    admission.acceptState(state("new", 2, "ready"));
    assert.equal(admission.takeReadyPort(), channel);
  }
});
