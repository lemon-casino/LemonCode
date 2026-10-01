import assert from "node:assert/strict";
import test from "node:test";
import type { ModelConnectivityResult } from "@lcode/shared";
import {
  removeInvalidModels,
  type RemoveInvalidModelResult,
} from "./removeInvalidModelOperations.js";

const invalid: ModelConnectivityResult = {
  success: false,
  error: { code: "model-not-found", message: "Model does not exist" },
};

function fixture() {
  const abort = new AbortController();
  const deleted: string[] = [];
  const results: RemoveInvalidModelResult[] = [];
  const input: Parameters<typeof removeInvalidModels>[0] = {
    ids: [],
    signal: abort.signal,
    probe: async () => invalid,
    remove: async (id, options) => {
      assert.deepEqual(options, { silentFeedback: true });
      deleted.push(id);
    },
    onResult: (result) => results.push(result),
  };
  return { input, abort, deleted, results };
}

test("all explicitly invalid models are removed once from the normalized snapshot", async () => {
  const { input, deleted, results } = fixture();
  const probed: string[] = [];
  await removeInvalidModels({
    ...input,
    ids: [" missing-a ", "missing-a", "", "missing-b", "Missing-A"],
    probe: async (id, options) => {
      assert.deepEqual(options, { mode: "temporary" });
      probed.push(id);
      return invalid;
    },
  });
  assert.deepEqual(probed, ["missing-a", "missing-b", "Missing-A"]);
  assert.deepEqual(deleted, probed);
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.status === "removed"));
});

test("successful probes keep disabled and inherited models without enabling them", async () => {
  const { input, deleted, results } = fixture();
  const configured = [
    { id: "disabled", enabled: false, builtin: false },
    { id: "inherited", enabled: true, builtin: true },
  ];
  const before = structuredClone(configured);
  await removeInvalidModels({
    ...input,
    ids: configured.map((model) => model.id),
    probe: async (_id, options) => {
      assert.deepEqual(options, { mode: "temporary" });
      assert.deepEqual(configured, before);
      return { success: true };
    },
  });
  assert.deepEqual(deleted, []);
  assert.deepEqual(configured, before);
  assert.deepEqual(
    results.map((result) => result.status),
    ["valid", "valid"],
  );
});

test("all failed probes only remove the structured model-not-found result", async () => {
  const { input, deleted, results } = fixture();
  const failures = new Map<string, ModelConnectivityResult>([
    ...[
      "timeout",
      "network",
      "HTTP 401",
      "HTTP 403",
      "HTTP 404",
      "HTTP 429",
      "HTTP 500",
      "HTTP 503",
      "model_not_found",
      "unknown",
    ].map((message): [string, ModelConnectivityResult] => [
      message,
      { success: false, error: { message } },
    ]),
    [
      "provider",
      { success: false, error: { code: "provider-unavailable", message: "Provider disabled" } },
    ],
    ["model", { success: false, error: { code: "model-unavailable", message: "Model disabled" } }],
    ["safe", invalid],
  ]);
  await removeInvalidModels({
    ...input,
    ids: [...failures.keys()],
    probe: async (id) => failures.get(id)!,
  });
  assert.deepEqual(deleted, ["safe"]);
  assert.equal(results.filter((result) => result.status === "unconfirmed").length, 12);
  assert.equal(results.find((result) => result.id === "HTTP 503")?.message, "HTTP 503");
});

test("probe exceptions remain unconfirmed and do not prevent later work", async () => {
  const { input, deleted, results } = fixture();
  await removeInvalidModels({
    ...input,
    ids: ["throws", "a", "b", "c", "later"],
    probe: async (id) => {
      if (id === "throws") throw new Error("Network unavailable");
      return invalid;
    },
  });
  assert.deepEqual(deleted, ["a", "b", "c", "later"]);
  assert.deepEqual(
    results.find((result) => result.id === "throws"),
    {
      id: "throws",
      status: "unconfirmed",
      message: "Network unavailable",
    },
  );
  assert.equal(results.length, 5);
});

test("cleanup uses four workers and does not extend the click-time snapshot", async () => {
  const { input, deleted } = fixture();
  const started: string[] = [];
  const ids = ["a", "b", "c", "d", "e"];
  let active = 0;
  let maximum = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = removeInvalidModels({
    ...input,
    ids,
    probe: async (id) => {
      started.push(id);
      active += 1;
      maximum = Math.max(maximum, active);
      await held;
      active -= 1;
      return invalid;
    },
  });
  assert.deepEqual(started, ["a", "b", "c", "d"]);
  ids.push("newly-configured");
  release();
  await running;
  assert.equal(maximum, 4);
  assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(deleted, started);
});

test("close or unmount cancels queued work and late invalid results cannot delete", async () => {
  const { input, abort, deleted, results } = fixture();
  const started: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = removeInvalidModels({
    ...input,
    ids: ["a", "b", "c", "d", "must-not-start"],
    probe: async (id) => {
      started.push(id);
      await held;
      return invalid;
    },
  });
  abort.abort();
  release();
  await running;
  assert.deepEqual(started, ["a", "b", "c", "d"]);
  assert.deepEqual(deleted, []);
  assert.deepEqual(results, []);
});

test("synchronous unmount from the start notification prevents the probe", async () => {
  const { input, abort, deleted, results } = fixture();
  const started: string[] = [];
  let probed = false;
  await removeInvalidModels({
    ...input,
    ids: ["a", "b", "c", "d", "e"],
    onStart: (id) => {
      started.push(id);
      abort.abort();
    },
    probe: async () => {
      probed = true;
      return invalid;
    },
  });
  assert.equal(probed, false);
  assert.deepEqual(started, ["a"]);
  assert.deepEqual(deleted, []);
  assert.deepEqual(results, []);
});

test("an already canceled cleanup dispatches nothing", async () => {
  const { input, abort, deleted, results } = fixture();
  abort.abort();
  await removeInvalidModels({
    ...input,
    ids: ["a"],
    probe: async () => assert.fail("Canceled cleanup must not probe"),
  });
  assert.deepEqual(deleted, []);
  assert.deepEqual(results, []);
});

test("deletion failure is visible and does not stop later items", async () => {
  const { input, deleted, results } = fixture();
  await removeInvalidModels({
    ...input,
    ids: ["cannot-delete", "a", "b", "c", "later"],
    remove: async (id, options) => {
      if (id === "cannot-delete") throw new Error("Configuration is read-only");
      await input.remove(id, options);
    },
  });
  assert.deepEqual(deleted, ["a", "b", "c", "later"]);
  assert.deepEqual(
    results.find((result) => result.id === "cannot-delete"),
    {
      id: "cannot-delete",
      status: "deleteFailed",
      message: "Configuration is read-only",
    },
  );
  assert.equal(results.length, 5);
});

test("a deletion accepted before close may finish without publishing stale results", async () => {
  const { input, abort, deleted, results } = fixture();
  let accepted!: () => void;
  let release!: () => void;
  const deleting = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = removeInvalidModels({
    ...input,
    ids: ["a"],
    remove: async (id, options) => {
      accepted();
      await held;
      await input.remove(id, options);
    },
  });
  await deleting;
  abort.abort();
  release();
  await running;
  assert.deepEqual(deleted, ["a"]);
  assert.deepEqual(results, []);
});
