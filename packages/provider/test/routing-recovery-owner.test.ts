import assert from "node:assert/strict";
import test from "node:test";
import { RoutingRecovery } from "../src/routing/recovery.js";

test("RCD-05 cooling expiry admits one probe and physical end alone cannot confirm recovery", () => {
  const owner = new RoutingRecovery();
  const failed = owner.reserve(["model"], "failed", 0);
  owner.dispatch(failed, 0);
  owner.fail(failed, ["model"], 100);
  assert.throws(() => owner.reserve(["model"], "early", 99), /route-cooling/);
  const probe = owner.reserve(["model"], "probe", 100);
  for (let i = 0; i < 20; i++)
    assert.throws(() => owner.reserve(["model"], `other-${i}`, 100), /route-cooling/);
  owner.dispatch(probe, 100);
  owner.finish(probe, "unknown", 100);
  assert.equal(owner.inspect(100)[0]!.phase, "uncertain");
  assert.throws(() => owner.reserve(["model"], "after-body", 1000), /route-cooling/);
  owner.observe(probe, "success", 1000);
  assert.ok(owner.reserve(["model"], "healthy", 1000));
});

test("RCD-05 unsent cancellation rolls back the probe, stale callbacks cannot change a later probe", () => {
  const owner = new RoutingRecovery();
  const failed = owner.reserve(["a"], "first", 0);
  owner.fail(failed, ["a"], 1);
  const probe = owner.reserve(["a"], "probe", 1);
  owner.cancel(probe);
  const replacement = owner.reserve(["a"], "replacement", 1);
  owner.cancel(probe);
  owner.finish(probe, "success", 2);
  owner.observe(probe, "success", 2);
  assert.throws(() => owner.reserve(["a"], "still-blocked", 2), /route-cooling/);
  owner.dispatch(replacement, 2);
  owner.observe(replacement, "success", 2);
  owner.finish(replacement, "unknown", 2);
  assert.ok(owner.reserve(["a"], "recovered", 2));
});

test("RCD-05 multiple resources admit atomically and distinct scopes remain independent", () => {
  const owner = new RoutingRecovery();
  const failed = owner.reserve(["a", "b"], "failure", 0);
  owner.fail(failed, ["a", "b"], 1);
  const b = owner.reserve(["b"], "b", 1);
  assert.throws(() => owner.reserve(["a", "b"], "both", 1), /route-cooling/);
  const a = owner.reserve(["a"], "a", 1);
  assert.ok(owner.reserve(["unrelated"], "unrelated", 1));
  owner.cancel(a);
  owner.cancel(b);
});

test("RCD-06 serializing and reopening recovery state retains an uncertain dispatched probe", () => {
  const state = {};
  const first = new RoutingRecovery(state);
  const failed = first.reserve(["pool"], "failed", 0);
  first.fail(failed, ["pool"], 1);
  const probe = first.reserve(["pool"], "probe", 1);
  first.dispatch(probe, 1);
  const second = new RoutingRecovery(JSON.parse(JSON.stringify(state)));
  assert.throws(() => second.reserve(["pool"], "new-process", 100000), /route-cooling/);
  assert.equal(JSON.stringify(second.inspect(100000)).includes('"probe":"probe"'), false);
});
