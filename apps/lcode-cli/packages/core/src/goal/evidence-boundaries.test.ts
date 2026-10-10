import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import type { SessionEntryInfo, FileSystemPort } from "@lcode/contracts";
import { evidenceFixture } from "./evidence.fixture.js";
import {
  beginGoalExecution,
  finishGoalExecution,
  readGoalEvidenceSummary,
  digestGoalFiles,
} from "./evidence.js";

const execution = {
  executionId: "check",
  source: "Bash" as const,
  command: "pnpm test",
  startedAt: 10,
};
const facts = {
  exitCode: 0,
  completedAt: 20,
  output: { sha256: "a".repeat(64), bytes: 0, truncated: false, artifactRefs: [] },
};

test("file coverage cannot hide changed bytes by moving NUL-delimited content between two files", async () => {
  const f = evidenceFixture();
  f.files.set(resolve(f.owner.workspacePath, "a"), "X\0b\0Y");
  f.files.set(resolve(f.owner.workspacePath, "b"), "Z");
  const first = await digestGoalFiles(f.owner, ["a", "b"]);
  f.files.set(resolve(f.owner.workspacePath, "a"), "X");
  f.files.set(resolve(f.owner.workspacePath, "b"), "Y\0b\0Z");
  assert.notEqual(await digestGoalFiles(f.owner, ["a", "b"]), first);
});

test("an explicit workspace-root symlink stays unknown rather than passing ancestor checks", async () => {
  const f = evidenceFixture();
  const stat = f.owner.fileSystem!.stat.bind(f.owner.fileSystem);
  f.owner.fileSystem = {
    ...f.owner.fileSystem,
    stat: async (request) =>
      request.path === f.owner.workspacePath
        ? { path: request.path, kind: "symlink", sizeBytes: 0, symlinkChecked: true }
        : stat(request),
  } as FileSystemPort;
  assert.equal(await digestGoalFiles(f.owner, ["source.ts"]), null);
});

test("pause/resume invalidates an in-flight receipt, including a state change during terminal digest IO", async () => {
  for (const duringRead of [false, true]) {
    const f = evidenceFixture();
    const original = { ...f.goal, stateRevision: 0 };
    f.setGoal(original);
    const capture = await beginGoalExecution(f.owner, execution);
    assert.ok(capture);
    if (duringRead) {
      const read = f.owner.fileSystem!.readBinaryFile.bind(f.owner.fileSystem);
      f.owner.fileSystem!.readBinaryFile = async (request) => {
        f.setGoal({ ...original, stateRevision: 2 });
        return read(request);
      };
    } else f.setGoal({ ...original, stateRevision: 2 });
    assert.deepEqual(await finishGoalExecution(capture, facts), []);
    assert.equal([...f.entries.values()].filter((entry) => entry.type === "goal/evidence/v1").length, 0);
    assert.equal((await readGoalEvidenceSummary(f.owner, original))?.outcome, "incomplete");
  }
});

test("failed checks become stale on new content and cannot request repair using old-version evidence", async () => {
  const f = evidenceFixture();
  const capture = await beginGoalExecution(f.owner, execution);
  assert.ok(capture);
  await finishGoalExecution(capture, { ...facts, exitCode: 1 });
  f.files.set(resolve(f.owner.workspacePath, "source.ts"), "repaired after failure");
  const summary = await readGoalEvidenceSummary(f.owner, f.goal);
  assert.equal(summary?.requirements[0]?.status, "stale");
  assert.equal(summary?.outcome, "incomplete");
});

test("a full evidence ledger rejects physical admission rather than dropping a later settlement", async () => {
  const f = evidenceFixture();
  const capture = await beginGoalExecution(f.owner, execution);
  assert.ok(capture);
  const [proof] = await finishGoalExecution(capture, facts);
  assert.ok(proof);
  for (let index = 1; index < 512; index++)
    f.entries.set(`filler-${index}`, {
      id: `filler-${index}`,
      sessionID: f.owner.sessionId,
      type: "goal/evidence/v1",
      time: { created: 10, updated: 20 },
      data: { ...proof, evidenceId: `filler-${index}`, goalId: "other" },
    } as SessionEntryInfo);
  await assert.rejects(beginGoalExecution(f.owner, { ...execution, executionId: "later-failure" }), /full/);
  assert.equal((await readGoalEvidenceSummary(f.owner, f.goal))?.outcome, "pass");
});
