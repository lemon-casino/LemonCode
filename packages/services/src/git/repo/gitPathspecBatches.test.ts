import assert from "node:assert/strict";
import test from "node:test";
import { batchGitPathspecs } from "./gitPathspecBatches.js";

test("任意总路径数按字节分批，完整保留中文、空格、换行和 literal 文件名", () => {
  const paths = Array.from({ length: 10_001 }, (_, i) => `src/中文 空格[${i}]\n.ts`);
  const batches = batchGitPathspecs(paths);
  assert.deepEqual(batches.flat(), paths);
  assert.ok(batches.length > 1);
  for (const batch of batches)
    assert.ok(batch.reduce((sum, path) => sum + Buffer.byteLength(path) * 2 + 3, 0) <= 8_000);
  assert.deepEqual(batchGitPathspecs([]), []);
});
