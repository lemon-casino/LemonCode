import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
test("HD-09 absent/null routing defaults to reliability and independent keys retain provider coordination", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-quota-legacy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const registry = new ApiKeyPoolRegistry(new FileSharedQuotaCoordinator(directory));
  for (const routing of [
    undefined,
    null,
    { version: 1 as const, strategy: "share-rotation" as const },
  ]) {
    const keys = [
      { id: "a", apiKey: "synthetic-a", ...(routing ? {} : { routing: { quotaPoolId: "team" } }) },
    ];
    const pool = registry.get("fixture", "generation", keys, routing);
    const lease = await pool.acquire();
    assert.equal(pool.routingEnabled, true);
    lease.release();
    await lease.flushRouting?.();
  }
  await registry.drain();
  registry.dispose();
  const files = (await readdir(directory)).filter((f) => f.endsWith(".json"));
  assert.equal(files.filter((f) => f.endsWith(".provider.json")).length, 1);
  for (const file of files.filter((f) => !f.endsWith(".provider.json"))) {
    const state = JSON.parse(await readFile(join(directory, file), "utf8"));
    assert.deepEqual(state.resources, {});
  }
  assert.ok(files.length <= 3);
});
