import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionUsageGroupModel } from "./sessionUsageGroups.js";

test("main session group is always visible", () => {
  assert.deepEqual(buildSessionUsageGroupModel(0), { main: true, child: false });
});

test("child group is visible only when a child session exists", () => {
  assert.deepEqual(buildSessionUsageGroupModel(1), { main: true, child: true });
  assert.deepEqual(buildSessionUsageGroupModel(3), { main: true, child: true });
});
