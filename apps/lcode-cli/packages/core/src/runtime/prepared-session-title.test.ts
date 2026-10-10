import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreparedSessionTitle,
  resolvePreparedSessionTitle,
} from "./prepared-session-title.js";
test("prepared naming seeds contain no task text and only match the frozen first input", () => {
  const input = "清理多个帮助入口并移除问题上报。\n保留其他功能。";
  const seed = createPreparedSessionTitle("清理帮助与问题上报入口", input)!;
  assert.equal(JSON.stringify(seed).includes(input), false);
  assert.match(seed.inputDigest, /^[0-9a-f]{64}$/u);
  assert.equal(
    resolvePreparedSessionTitle({ titleGeneration: { preparedTitle: seed } }, input),
    seed.title,
  );
  assert.equal(
    resolvePreparedSessionTitle({ titleGeneration: { preparedTitle: seed } }, input + "有新要求"),
    undefined,
  );
  for (const config of [
    { titleGeneration: { enabled: false, preparedTitle: seed } },
    { parentSessionId: "parent", titleGeneration: { preparedTitle: seed } },
    { taskType: "worktree_repair", titleGeneration: { preparedTitle: seed } },
  ])
    assert.equal(resolvePreparedSessionTitle(config as never, input), undefined);
  assert.equal(createPreparedSessionTitle("超长".repeat(20), input), undefined);
});
