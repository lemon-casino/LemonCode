import assert from "node:assert/strict";
import test from "node:test";
import { probeAndSyncModel } from "./syncModelOperations.js";

function fixture(configured = false) {
  const abort = new AbortController();
  const writes: string[] = [];
  let present = configured;
  const input: Parameters<typeof probeAndSyncModel>[0] = {
    id: "model-a",
    signal: abort.signal,
    isConfigured: () => present,
    probe: async () => ({ success: true }),
    add: async () => {
      writes.push("add");
      present = true;
    },
    setEnabled: async (enabled: boolean) => {
      writes.push(`enabled:${enabled}`);
    },
  };
  return { input, writes, abort };
}

test("new model is only added after a successful probe", async () => {
  const { input, writes } = fixture();
  const events: string[] = [];
  const result = await probeAndSyncModel({
    ...input,
    probe: async () => {
      events.push("probe");
      assert.deepEqual(writes, []);
      return { success: true };
    },
    add: async () => {
      events.push("add");
      await input.add();
    },
  });
  assert.equal(result.success, true);
  assert.deepEqual(events, ["probe", "add"]);
  assert.deepEqual(writes, ["add"]);
});

test("failed and thrown probes never add an unconfigured model", async () => {
  for (const throws of [false, true]) {
    const { input, writes } = fixture();
    const result = await probeAndSyncModel({
      ...input,
      probe: async () => {
        if (throws) throw new Error("HTTP 403");
        return { success: false, error: { message: "HTTP 403" } };
      },
    });
    assert.equal(result.success, false);
    assert.equal(result.message, "HTTP 403");
    assert.deepEqual(writes, []);
  }
});

test("configured model is probed before changing its enabled state and never re-added", async () => {
  for (const success of [true, false]) {
    const { input, writes } = fixture(true);
    const result = await probeAndSyncModel({
      ...input,
      probe: async () => {
        assert.deepEqual(writes, []);
        return { success, error: { message: "unavailable" } };
      },
    });
    assert.equal(result.success, success);
    assert.deepEqual(writes, [`enabled:${success}`]);
  }
});

test("closing while probe is in flight prevents both additions and enable changes", async () => {
  for (const configured of [false, true]) {
    const { input, writes, abort } = fixture(configured);
    await probeAndSyncModel({
      ...input,
      probe: async () => {
        abort.abort();
        return { success: true };
      },
    });
    assert.deepEqual(writes, []);
  }
});

test("a configured model deleted during the probe is not silently restored", async () => {
  const { input, writes } = fixture(true);
  let configured = true;
  await probeAndSyncModel({
    ...input,
    isConfigured: () => configured,
    probe: async () => {
      configured = false;
      return { success: true };
    },
  });
  assert.deepEqual(writes, []);
});

test("an already canceled operation does not send a probe", async () => {
  const { input, abort, writes } = fixture();
  abort.abort();
  await probeAndSyncModel({
    ...input,
    probe: async () => {
      assert.fail("canceled operation must not dispatch");
    },
  });
  assert.deepEqual(writes, []);
});

test("save failures remain distinct from connectivity failures", async () => {
  const { input } = fixture();
  const result = await probeAndSyncModel({
    ...input,
    add: async () => {
      throw new Error("read-only configuration");
    },
  });
  assert.equal(result.success, false);
  assert.equal(result.stage, "save");
  assert.equal(result.message, "read-only configuration");
});

test("repeating a successful sync only enables the existing row", async () => {
  const { input, writes } = fixture();
  await probeAndSyncModel(input);
  await probeAndSyncModel(input);
  assert.deepEqual(writes, ["add", "enabled:true"]);
});
