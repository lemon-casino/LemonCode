import assert from "node:assert/strict";
import { test } from "node:test";
import { advanceStatus, isBusyStatus, isConsumableStatus } from "./domain/state.js";

test("forward path walks allocated to ready", () => {
  const step1 = advanceStatus("allocated", "step");
  assert.equal(step1.status, "resolvingTools");
  const step2 = advanceStatus(step1.status, "step");
  assert.equal(step2.status, "installingTools");
  const step3 = advanceStatus(step2.status, "step");
  assert.equal(step3.status, "preparingDependencies");
  assert.equal(advanceStatus(step3.status, "ready").status, "ready");
});

test("needsUpdate re-enters resolvingTools on step", () => {
  assert.equal(advanceStatus("needsUpdate", "step").status, "resolvingTools");
});

test("ready → needsUpdate", () => {
  assert.equal(advanceStatus("ready", "step").status, "needsUpdate");
});

test("fail from any active stage lands failed; ready does not resurrect to failed via fail", () => {
  assert.equal(advanceStatus("installingTools", "fail").status, "failed");
  const invalid = advanceStatus("ready", "fail");
  assert.equal(invalid.status, "ready");
  assert.equal(invalid.invalid, true);
});

test("cancel from active stages enters cancelling and settles cancelled once", () => {
  assert.equal(advanceStatus("resolvingTools", "cancel-requested").status, "cancelling");
  assert.equal(advanceStatus("cancelling", "cancelled").status, "cancelled");
  const settle = advanceStatus("cancelled", "cancelled");
  assert.equal(settle.invalid, true);
  assert.equal(settle.status, "cancelled");
});

test("cancelled is a settlement state: repeated cancel is a no-op, fail is invalid", () => {
  const repeat = advanceStatus("cancelled", "cancel-requested");
  assert.equal(repeat.status, "cancelled");
  assert.equal(repeat.invalid, undefined);
  assert.equal(advanceStatus("cancelled", "fail").invalid, true);
});

test("release accepted from live and settled-but-not-released states", () => {
  for (const from of ["ready", "failed", "cancelled", "needsUpdate"] as const) {
    assert.equal(advanceStatus(from, "release").status, "releasing");
  }
  assert.equal(advanceStatus("released", "release").invalid, true);
});

test("release blocks only from releasing and settles released", () => {
  assert.equal(advanceStatus("releasing", "release-blocked").status, "releaseBlocked");
  assert.equal(advanceStatus("releaseBlocked", "released").status, "released");
  assert.equal(advanceStatus("ready", "released").invalid, true);
});

test("explicit retry is modelled by needsUpdate/failed stepping back to resolvingTools", () => {
  // failed 状态的重试经显式 prepare 新 revision（needsUpdate→resolvingTools）；
  // 状态机本身不自动从 failed 前进（invalid）。
  assert.equal(advanceStatus("failed", "step").invalid, true);
  assert.equal(advanceStatus("failed", "release").status, "releasing");
});

test("busy and consumable predicates", () => {
  assert.equal(isBusyStatus("installingTools"), true);
  assert.equal(isBusyStatus("cancelling"), true);
  assert.equal(isBusyStatus("ready"), false);
  assert.equal(isConsumableStatus("ready"), true);
  assert.equal(isConsumableStatus("needsUpdate"), true);
  assert.equal(isConsumableStatus("failed"), false);
});
