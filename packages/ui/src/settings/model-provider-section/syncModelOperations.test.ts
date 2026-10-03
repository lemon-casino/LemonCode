import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_PROBE_CONCURRENCY,
  filterModelIds,
  normalizeModelIds,
  probeTargetIds,
  runCancelablePool,
  selectedModelIds,
} from "./syncModelOperations.js";

test("selection snapshot keeps only checked rows in visible order", () => {
  const rows = ["remote-a", "remote-b", "local-only"];
  assert.deepEqual(selectedModelIds(rows, new Set(rows)), rows);
  assert.deepEqual(selectedModelIds(rows, new Set(["local-only", "remote-b"])), [
    "remote-b",
    "local-only",
  ]);
  assert.deepEqual(selectedModelIds(rows, new Set()), []);
});

test("catalog and selection normalize duplicate IDs without merging API aliases", () => {
  const rows = [" model-a ", "model-a", "", "model-b", "Model-A", "model-a-preview"];
  assert.deepEqual(normalizeModelIds(rows), ["model-a", "model-b", "Model-A", "model-a-preview"]);
  assert.deepEqual(selectedModelIds(rows, new Set(["model-a", "model-b"])), ["model-a", "model-b"]);
});

test("search trims queries and matches model IDs case-insensitively without changing IDs", () => {
  const rows = ["deepseek-flash", "DeepSeek-V4-Pro", "gpt-5", "claude-model"];
  assert.deepEqual(filterModelIds(rows, " DEEPseek "), ["deepseek-flash", "DeepSeek-V4-Pro"]);
  assert.deepEqual(filterModelIds(rows, "V4"), ["DeepSeek-V4-Pro"]);
  assert.deepEqual(filterModelIds(rows, "missing"), []);
  assert.deepEqual(filterModelIds(rows, "  "), rows);
});

test("search leaves selection unchanged until selecting results replaces the scope", () => {
  const rows = ["deepseek-flash", "deepseek-pro", "gpt-5"];
  const selected = new Set(rows);
  const matching = filterModelIds(rows, "deepseek");
  assert.deepEqual(selectedModelIds(rows, selected), rows);
  assert.deepEqual(selectedModelIds(rows, new Set(matching)), ["deepseek-flash", "deepseek-pro"]);
  assert.deepEqual(filterModelIds(rows, ""), rows);
});

test("search scopes the submit target to matches intersected with selection", () => {
  const rows = ["deepseek-flash", "deepseek-pro", "gpt-5", "claude-model"];
  const visible = filterModelIds(rows, "deepseek");
  // 默认全选：搜索时只提交匹配项，数量即搜索命中数。
  assert.deepEqual(probeTargetIds(rows, visible, new Set(rows), true), [
    "deepseek-flash",
    "deepseek-pro",
  ]);
  // 取消部分勾选后匹配项被排除，数量随之收缩；全部取消则禁用提交。
  assert.deepEqual(probeTargetIds(rows, visible, new Set(["deepseek-pro"]), true), [
    "deepseek-pro",
  ]);
  assert.deepEqual(probeTargetIds(rows, visible, new Set(), true), []);
  // 无查询（含纯空白）时仍取全局勾选快照，不受过滤影响。
  assert.deepEqual(probeTargetIds(rows, filterModelIds(rows, "  "), new Set(rows), false), rows);
});

test("default probe pool starts four requests before any one finishes", async () => {
  const started: string[] = [];
  const releases: Array<() => void> = [];
  let continuing = true;
  const running = runCancelablePool({
    items: ["a", "b", "c", "d", "e"],
    concurrency: MODEL_PROBE_CONCURRENCY,
    shouldContinue: () => continuing,
    run: async (id) => {
      started.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      return id;
    },
    onResult: () => {},
  });
  assert.deepEqual(started, ["a", "b", "c", "d"]);
  continuing = false;
  releases.forEach((release) => release());
  await running;
  assert.deepEqual(started, ["a", "b", "c", "d"]);
});

test("probe pool never exceeds the configured concurrency", async () => {
  let active = 0;
  let maximum = 0;
  const results: number[] = [];
  await runCancelablePool({
    items: [1, 2, 3, 4, 5, 6],
    concurrency: 3,
    shouldContinue: () => true,
    run: async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item;
    },
    onResult: (result) => results.push(result),
  });
  assert.equal(maximum, 3);
  assert.equal(results.length, 6);
});

test("cancellation stops scheduling remaining probes and drops late results", async () => {
  let continuing = true;
  let started = 0;
  const releases: Array<() => void> = [];
  const results: number[] = [];
  const running = runCancelablePool({
    items: [1, 2, 3, 4, 5],
    concurrency: 2,
    shouldContinue: () => continuing,
    run: async (item) => {
      started += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
      return item;
    },
    onResult: (result) => results.push(result),
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(started, 2);
  continuing = false;
  for (const release of releases) release();
  await running;
  assert.equal(started, 2);
  assert.deepEqual(results, []);
});
