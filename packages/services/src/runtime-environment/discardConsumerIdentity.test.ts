import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeConsumerReference } from "@lcode/shared";
import type { RuntimeConsumerOwnerReceipt } from "./contract.js";
import { discardConsumerEligibility } from "./app/discardConsumerEligibility.js";

const instance = "agent-11111111-1111-4111-8111-111111111111";
const ref: RuntimeConsumerReference = {
  environmentId: "environment",
  kind: "process",
  revision: 1,
  id: JSON.stringify(["session", "22222222-2222-4222-8222-222222222222"]),
  ownerId: `runtime-agent-${instance}`,
  ownerGeneration: 1,
  lease: "lease",
  state: "active",
  createdAt: "2026-10-09T00:00:00.000Z",
  updatedAt: "2026-10-09T00:00:00.000Z",
};
const receipt: RuntimeConsumerOwnerReceipt = {
  ...ref,
  kind: "process",
  processOwner: {
    runtimeInstanceId: instance,
    runtimeGeneration: 1,
    workspacePath: "/original",
    startedAt: 1,
    pid: 1,
  },
};

test("opaque production identity needs an exact receipt; no-receipt migration retains its UUID boundary", async () => {
  const sessions = new Set(["session"]);
  assert.equal(await discardConsumerEligibility(ref, 1, sessions, [], () => "absent"), undefined);
  assert.deepEqual(await discardConsumerEligibility(ref, 1, sessions, [receipt], () => "absent"), {
    orphanedOwner: receipt.processOwner,
  });
});

test("opaque identity cannot bypass exact session, owner generation, revision or owner instance", async () => {
  for (const owner of [
    { ...receipt, ownerGeneration: 2 },
    { ...receipt, revision: 2 },
    {
      ...receipt,
      processOwner: { ...receipt.processOwner, runtimeInstanceId: "another-instance" },
    },
  ])
    assert.equal(
      await discardConsumerEligibility(ref, 1, new Set(["session"]), [owner], () => "absent"),
      undefined,
    );
  assert.equal(
    await discardConsumerEligibility(ref, 1, new Set(["foreign"]), [receipt], () => "absent"),
    undefined,
  );
});
