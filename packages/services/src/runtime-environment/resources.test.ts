import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  createRuntimeEnvironmentStore,
  environmentResourceDirs,
  runtimeEnvironmentDataDirs,
} from "./adapters/store.js";

async function mkTemp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "lcode-p305-"));
}

test("resource dirs isolate per environment under the managed root", () => {
  const dirsA = environmentResourceDirs("C:/host-data/runtime-environments", "a".repeat(32));
  const dirsB = environmentResourceDirs("C:/host-data/runtime-environments", "b".repeat(32));
  assert.equal(
    resolve(dirsA.data).startsWith(resolve("C:/host-data/runtime-environments/resources")),
    true,
  );
  assert.notEqual(dirsA.data, dirsB.data);
  assert.notEqual(dirsA.temp, dirsB.temp);
  // 四个子目录同根隔离（spec §8.3：temp/cache/data/logs）。
  for (const key of ["temp", "cache", "data", "logs"] as const) {
    assert.equal(resolve(dirsA[key]).startsWith(resolve(dirsA.environmentRoot) + sep), true);
  }
});

test("resource dirs reject non-managed environment ids (no path traversal)", () => {
  assert.throws(() => environmentResourceDirs("C:/host-data", "../escape"));
  assert.throws(() => environmentResourceDirs("C:/host-data", "short"));
  assert.throws(() => environmentResourceDirs("C:/host-data", "A".repeat(32)));
});

test("data dirs layout keeps backends/stores as siblings of worktree data", () => {
  const dirs = runtimeEnvironmentDataDirs("C:/host-data/runtime-environments");
  assert.equal(isAbsolute(dirs.toolBackends), true);
  assert.match(dirs.toolBackends, /tool-backends$/);
  assert.match(dirs.toolStore, /tool-store$/);
  assert.match(dirs.packageStore, /package-store$/);
});

test("service receipts persist per environment+service with schema validation", async () => {
  const dir = await mkTemp();
  try {
    const store = createRuntimeEnvironmentStore(dir);
    const receipt = {
      environmentId: "c".repeat(32),
      revision: 1,
      serviceId: "dev-server",
      generation: 1,
      state: "running" as const,
      urls: ["http://127.0.0.1:5173"],
      startedAt: "2026-10-05T00:00:00.000Z",
      healthCheckedAt: "2026-10-05T00:00:01.000Z",
    };
    await store.saveServiceReceipt(receipt);
    const readBack = await store.readServiceReceipt(receipt.environmentId, "dev-server");
    assert.equal(readBack?.generation, 1);
    assert.equal(readBack?.state, "running");
    // 损坏记录明确失败（不静默返回 null）。
    const files = await readdir(join(dir, "services"));
    await writeFile(join(dir, "services", files[0]!), "{broken", "utf8");
    await assert.rejects(
      store.readServiceReceipt(receipt.environmentId, "dev-server"),
      /corrupt or has an unknown schema version/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
