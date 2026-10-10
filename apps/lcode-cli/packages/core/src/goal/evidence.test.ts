import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  beginGoalExecution,
  finishGoalExecution,
  readGoalEvidenceSummary,
  digestGoalFiles,
} from "./evidence.js";
import { evidenceFixture } from "./evidence.fixture.js";
const facts = {
  exitCode: 0,
  completedAt: 20,
  output: { sha256: "a".repeat(64), bytes: 5, truncated: false, artifactRefs: [] },
};
test("real matching execution passes only declared coverage; mutated uncommitted bytes become stale", async () => {
  const fixture = evidenceFixture();
  const capture = await beginGoalExecution(fixture.owner, {
    executionId: "tool-1",
    source: "Bash",
    command: "pnpm test",
    startedAt: 10,
  });
  assert.ok(capture);
  assert.equal((await finishGoalExecution(capture, facts))[0]?.status, "passed");
  assert.equal((await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.outcome, "pass");
  fixture.files.set(resolve(fixture.owner.workspacePath, "source.ts"), "changed with same HEAD");
  assert.equal(
    (await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.requirements[0]?.status,
    "stale",
  );
});
test("writes during checks, absent exit, absent artifacts and unsupported coverage cannot pass", async () => {
  for (const scenario of [
    "mutated",
    "missing-exit",
    "missing-artifact",
    "symlink",
    "oversized",
  ] as const) {
    const fixture = evidenceFixture();
    if (scenario === "symlink") fixture.setSymlink();
    if (scenario === "oversized")
      fixture.files.set(
        resolve(fixture.owner.workspacePath, "source.ts"),
        "x".repeat(4 * 1024 * 1024 + 1),
      );
    if (scenario === "symlink" || scenario === "oversized") {
      await assert.rejects(beginGoalExecution(fixture.owner, { executionId: scenario, source: "Bash", command: "pnpm test", startedAt: 10 }), /not verifiable/);
      assert.equal((await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.outcome, "incomplete");
      continue;
    }
    const capture = await beginGoalExecution(fixture.owner, {
      executionId: scenario,
      source: "Bash",
      command: "pnpm test",
      startedAt: 10,
    });
    assert.ok(capture);
    if (scenario === "mutated")
      fixture.files.set(resolve(fixture.owner.workspacePath, "source.ts"), "mid-command edit");
    if (scenario === "missing-artifact")
      fixture.files.delete(resolve(fixture.owner.workspacePath, "out.txt"));
    const result = await finishGoalExecution(capture, {
      ...facts,
      exitCode: scenario === "missing-exit" ? null : 0,
    });
    assert.notEqual(result[0]?.status, "passed", scenario);
  }
});
test("exact command binding, identity isolation, goal replacement and repeated terminal facts", async () => {
  const fixture = evidenceFixture();
  assert.equal(
    await beginGoalExecution(fixture.owner, {
      executionId: "wrong",
      source: "Bash",
      command: "echo passed",
      startedAt: 10,
    }),
    null,
  );
  const capture = await beginGoalExecution(fixture.owner, {
    executionId: "same",
    source: "Bash",
    command: "pnpm test",
    startedAt: 10,
  });
  assert.ok(capture);
  await finishGoalExecution(capture, facts);
  await finishGoalExecution(capture, { ...facts, completedAt: 99, exitCode: 1 });
  assert.equal([...fixture.entries.values()].filter((entry) => entry.type === "goal/evidence/v1").length, 1);
  assert.equal((await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.outcome, "pass");
  assert.equal(
    (await readGoalEvidenceSummary({ ...fixture.owner, workspaceKey: "other" }, fixture.goal))
      ?.requirements[0]?.status,
    "unknown",
  );
  fixture.setGoal({ ...fixture.goal, targetID: "replacement" });
  assert.deepEqual(await finishGoalExecution(capture, facts), []);
  assert.equal(await digestGoalFiles(fixture.owner, ["../outside"]), null);
});
test("real failures are repairable and the current durable attempt orders same-timestamp verdicts", async () => {
  const fixture = evidenceFixture();
  const failed = await beginGoalExecution(fixture.owner, {
    executionId: "failure",
    source: "Bash",
    command: "pnpm test",
    startedAt: 10,
  });
  assert.ok(failed);
  await finishGoalExecution(failed, { ...facts, exitCode: 1 });
  assert.equal(
    (await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.outcome,
    "notSatisfied",
  );
  const passing = await beginGoalExecution(fixture.owner, {
    executionId: "parallel-pass",
    source: "Bash",
    command: "pnpm test",
    startedAt: 10,
  });
  assert.ok(passing);
  await finishGoalExecution(passing, facts);
  assert.equal(
    (await readGoalEvidenceSummary(fixture.owner, fixture.goal))?.requirements[0]?.status,
    "passed",
  );
});

test("a late older terminal cannot reclaim a newer head and settled proof survives business pause/resume", async () => {
  const f = evidenceFixture();
  const execution = { source: "Bash" as const, command: "pnpm test", startedAt: 10 };
  const old = await beginGoalExecution(f.owner, { ...execution, executionId: "old" });
  const newer = await beginGoalExecution(f.owner, { ...execution, executionId: "newer" });
  assert.ok(old);
  assert.ok(newer);
  await finishGoalExecution(newer, { ...facts, exitCode: 1 });
  await finishGoalExecution(old, { ...facts, completedAt: 100 });
  assert.equal((await readGoalEvidenceSummary(f.owner, f.goal))?.outcome, "notSatisfied");
  f.setGoal({ ...f.goal, stateRevision: 2 });
  assert.equal((await readGoalEvidenceSummary(f.owner, { ...f.goal, stateRevision: 2 }))?.outcome, "notSatisfied");
});
