import assert from "node:assert/strict";
import test from "node:test";
import {
  readWorkflowOrchestrationAdvice,
  workflowOrchestrationAdviceBundleSchema,
  workflowScriptFingerprint,
} from "./workflow-orchestration-advice.js";

const SCRIPT = 'phase("Inspect"); await agent("服务").ask("Inspect");';
const ITEM = {
  code: "await-before-later-asks",
  line: 1,
  column: 19,
  waitingOn: [{ line: 1, column: 37 }],
  delayed: [
    { line: 2, column: 6 },
    { line: 3, column: 6 },
  ],
  message: "Check whether independent read-only investigations can start earlier.",
} as const;

function raw(items: unknown = [ITEM]) {
  return {
    script: SCRIPT,
    orchestration_advice: { scriptHash: workflowScriptFingerprint(SCRIPT), items },
  };
}

test("confirmation reads only bounded advice attached to the unchanged script", () => {
  assert.deepEqual(readWorkflowOrchestrationAdvice(raw()), [ITEM]);
  assert.deepEqual(
    readWorkflowOrchestrationAdvice({ ...raw(), script: `${SCRIPT}\nreturn 1;` }),
    [],
  );
  assert.deepEqual(readWorkflowOrchestrationAdvice({ script: SCRIPT }), []);
  assert.deepEqual(readWorkflowOrchestrationAdvice(null), []);
});

test("confirmation fingerprint preserves non-ASCII and exact whitespace", () => {
  assert.equal(workflowScriptFingerprint(SCRIPT), workflowScriptFingerprint(SCRIPT));
  assert.notEqual(workflowScriptFingerprint(SCRIPT), workflowScriptFingerprint(`${SCRIPT} `));
  assert.notEqual(workflowScriptFingerprint("服务"), workflowScriptFingerprint("界面"));
});

test("advice does not relax strict source locations, codes or payload bounds", () => {
  for (const items of [
    [{ ...ITEM, code: "automatically-parallelize" }],
    [{ ...ITEM, line: 0 }],
    [{ ...ITEM, delayed: [] }],
    [{ ...ITEM, delayed: Array.from({ length: 9 }, () => ({ line: 2, column: 6 })) }],
    [{ ...ITEM, message: "x".repeat(1025) }],
    Array.from({ length: 6 }, () => ITEM),
    [{ ...ITEM, autoFix: true }],
  ]) {
    assert.deepEqual(readWorkflowOrchestrationAdvice(raw(items)), []);
    assert.equal(
      workflowOrchestrationAdviceBundleSchema.safeParse(raw(items).orchestration_advice).success,
      false,
    );
  }
});
