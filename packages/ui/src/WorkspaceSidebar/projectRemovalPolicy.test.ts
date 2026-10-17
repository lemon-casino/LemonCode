import assert from "node:assert/strict";
import test from "node:test";
import { projectRemovalBlockedReason } from "./projectRemovalPolicy.js";

const disconnected = {
  hasExecutionSets: false,
  hasIndependentChats: false,
  hasWorktrees: false,
  isRemote: true,
  sourceConnected: false,
  sourceLoading: false,
  sourceUnavailable: true,
};

test("failed remote placeholders can be removed without reconnecting or verifying an absent owner", () => {
  assert.equal(projectRemovalBlockedReason(disconnected), undefined);
  assert.equal(projectRemovalBlockedReason({ ...disconnected, sourceLoading: true }), undefined);
});

test("known dependencies keep disconnected origins protected", () => {
  for (const [flag, reason] of [
    ["hasExecutionSets", "activeExecutionSet"],
    ["hasIndependentChats", "dependentChats"],
    ["hasWorktrees", "activeBinding"],
  ] as const)
    assert.equal(projectRemovalBlockedReason({ ...disconnected, [flag]: true }), reason);
});

test("local and connected remote sources still require their own verification", () => {
  for (const isRemote of [false, true]) {
    const facts = { ...disconnected, isRemote, sourceConnected: true };
    assert.equal(projectRemovalBlockedReason(facts), "verifySource");
    assert.equal(
      projectRemovalBlockedReason({ ...facts, sourceUnavailable: false, sourceLoading: true }),
      "verifySource",
    );
    assert.equal(projectRemovalBlockedReason({ ...facts, sourceUnavailable: false }), undefined);
  }
});
