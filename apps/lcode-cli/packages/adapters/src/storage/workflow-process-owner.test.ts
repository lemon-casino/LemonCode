import assert from "node:assert/strict";
import test from "node:test";
import { currentWorkflowProcessIdentity, probeWorkflowOwner } from "./workflow-process-owner.js";
import { probeProcessStartTimeDefault } from "./workspace-hook-trust-lock.js";

test("own process identity uses process uptime and remains live across owner probes", async () => {
  const identity = currentWorkflowProcessIdentity();
  assert.ok(Math.abs(identity.startedAt - (Date.now() - process.uptime() * 1_000)) < 100);
  assert.ok(
    Math.abs((await probeProcessStartTimeDefault(process.pid))! - identity.startedAt) < 100,
  );
  assert.equal(await probeWorkflowOwner(identity, identity), "alive");
  assert.equal(
    await probeWorkflowOwner({ ...identity, hostId: "other-host" }, identity),
    "unknown",
  );
});
