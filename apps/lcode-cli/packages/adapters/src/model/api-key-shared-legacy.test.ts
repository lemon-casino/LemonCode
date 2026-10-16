import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiKeyPoolRegistry } from "./api-key-pool.js";
import { FileSharedQuotaCoordinator } from "./api-key-shared-quota.js";
test("XQP-11 absent/null routing and independent enhanced Keys do not create shared quota files", async (t) => {
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
    lease.release();
  }
  await registry.drain();
  registry.dispose();
  assert.deepEqual(await readdir(directory), []);
});
