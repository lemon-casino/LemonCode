import assert from "node:assert/strict";
import test from "node:test";
import { analyzeWorkflowScript } from "./analyze.js";
import { decodeAnalysisCore, encodeAnalysisCore } from "./core-json.js";

const ACTORS = [
  'phase("Inspect the current interfaces");',
  'const service = agent("Service researcher");',
  'const ui = agent("UI researcher");',
  'const tests = agent("Test researcher");',
].join("\n");

const SERIAL_FRONTIER = `${ACTORS}
await service.ask("Locate the service contract; no edits.");
const uiWork = ui.ask("Locate consumers; no edits.");
const testWork = tests.ask("Locate tests; no edits.");
return await Promise.all([uiWork, testWork]);`;

function analyze(script: string) {
  const result = analyzeWorkflowScript(script);
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(result.diagnostics, []);
  return result;
}

test("an exact await reports the located control wait without blocking compilation", () => {
  const result = analyze(SERIAL_FRONTIER);
  assert.equal(result.orchestrationAdvice?.length, 1);
  const advice = result.orchestrationAdvice?.[0];
  assert.ok(advice);
  assert.equal(advice.code, "await-before-later-asks");
  assert.deepEqual({ line: advice.line, column: advice.column }, { line: 5, column: 1 });
  assert.deepEqual(advice.waitingOn, [{ line: 5, column: 15 }]);
  assert.deepEqual(advice.delayed, [
    { line: 6, column: 19 },
    { line: 7, column: 24 },
  ]);
  assert.match(advice.message, /control|wait/i);
  assert.match(advice.message, /check/i);
  assert.match(advice.message, /file.*permission.*actor.*external/i);
});

test("a full tuple join reports a later consumer of only one branch", () => {
  const result = analyze(`${ACTORS}
const [serviceResult, uiResult] = await Promise.all([
  service.ask("Inspect service"),
  ui.ask("Inspect UI"),
]);
const checked = await tests.ask(serviceResult);
return { checked, uiResult };`);
  assert.equal(result.orchestrationAdvice?.length, 1);
  const advice = result.orchestrationAdvice?.[0];
  assert.ok(advice);
  assert.equal(advice.code, "join-before-per-item-work");
  assert.deepEqual({ line: advice.line, column: advice.column }, { line: 5, column: 35 });
  assert.deepEqual(advice.waitingOn, [
    { line: 6, column: 11 },
    { line: 7, column: 6 },
  ]);
  assert.deepEqual(advice.delayed, [{ line: 9, column: 29 }]);
});

const QUIET_CASES: Record<string, string> = {
  "already parallel": `${ACTORS}
const serviceWork = service.ask("Inspect service");
const uiWork = ui.ask("Inspect UI");
const testWork = tests.ask("Inspect tests");
return await Promise.all([serviceWork, uiWork, testWork]);`,
  "same actor FIFO": `${ACTORS}
await service.ask("Establish context");
const next = service.ask("Use the previous context");
const last = service.ask("Use the next context");
return await Promise.all([next, last]);`,
  "full-data join": `${ACTORS}
const both = await Promise.all([service.ask("Inspect service"), ui.ask("Inspect UI")]);
return await tests.ask(JSON.stringify(both));`,
  "true data dependencies": `${ACTORS}
const contract = await service.ask("Define contract");
const uiWork = ui.ask(contract);
const testWork = tests.ask(contract);
return await Promise.all([uiWork, testWork]);`,
  "safety branch": `${ACTORS}
const allowed = await service.ask("Check permission");
if (allowed === "yes") {
  const uiWork = ui.ask("Write UI");
  const testWork = tests.ask("Write tests");
  return await Promise.all([uiWork, testWork]);
}
return "not authorized";`,
  "conditional receiver": `${ACTORS}
const chosen = args.chooseUi ? ui : service;
await chosen.ask("Inspect");
const uiWork = ui.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([uiWork, testWork]);`,
  loop: `${ACTORS}
for (let i = 0; i < 2; i += 1) {
  await service.ask("Inspect");
  const uiWork = ui.ask("Read UI");
  const testWork = tests.ask("Read tests");
  await Promise.all([uiWork, testWork]);
}`,
  "helper strand": `${ACTORS}
async function inspect() {
  await service.ask("Inspect");
  const uiWork = ui.ask("Read UI");
  const testWork = tests.ask("Read tests");
  return await Promise.all([uiWork, testWork]);
}
return await inspect();`,
  "non-join promise combinator": `${ACTORS}
await Promise.race([service.ask("Inspect"), Promise.resolve("already ready")]);
const uiWork = ui.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([uiWork, testWork]);`,
  "unreachable straight-line suffix": `${ACTORS}
return "already done";
await service.ask("Inspect");
const uiWork = ui.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([uiWork, testWork]);`,
  "all branches return before suffix": `${ACTORS}
if (args.stop) return 1;
else return 2;
await service.ask("Inspect");
const uiWork = ui.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([uiWork, testWork]);`,
  "optional later receiver": `${ACTORS}
const maybeUi = args.skip ? undefined : ui;
await service.ask("Inspect");
const uiWork = maybeUi?.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([uiWork, testWork]);`,
  "optional ask": `${ACTORS}
const maybeService = args.skip ? undefined : service;
await maybeService?.ask("Inspect");
const uiWork = ui.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([uiWork, testWork]);`,
  "unknown barrier": `${ACTORS}
const pending = service.ask("Inspect");
await Promise.resolve(1);
const uiWork = ui.ask("Read UI");
const testWork = tests.ask("Read tests");
return await Promise.all([pending, uiWork, testWork]);`,
  "join consumer on a joined actor": `${ACTORS}
const [a, b] = await Promise.all([service.ask("Inspect service"), ui.ask("Inspect UI")]);
return await ui.ask(a + b);`,
};

for (const [name, source] of Object.entries(QUIET_CASES)) {
  test(`no speculative advice for ${name}`, () => {
    assert.deepEqual(analyze(source).orchestrationAdvice ?? [], []);
  });
}

test("invalid scripts only return blocking diagnostics", () => {
  const result = analyzeWorkflowScript("return missing;");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.length > 0);
  assert.deepEqual(result.orchestrationAdvice ?? [], []);
});

test("core serialization retains exact await evidence without changing graph facts", async () => {
  const result = analyze(SERIAL_FRONTIER);
  assert.ok(result.core);
  const restored = decodeAnalysisCore(JSON.parse(JSON.stringify(encodeAnalysisCore(result.core))));
  const { projectOrchestrationAdvice } = await import("./orchestration-advice.js");
  assert.deepEqual(projectOrchestrationAdvice(restored), result.orchestrationAdvice);
  // 旧 core 没有 await 位置时不能借 ask 的位置伪造一条提示。
  for (const event of restored.trace.events) {
    if (event.at === "settle") delete event.loc;
  }
  assert.deepEqual(projectOrchestrationAdvice(restored), []);
});
