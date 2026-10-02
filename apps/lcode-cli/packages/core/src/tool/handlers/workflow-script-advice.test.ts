import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CreateWorkflowOutputSchema,
  type DynamicWorkflowRunAmendRequest,
  type DynamicWorkflowRunPort,
  type DynamicWorkflowRunSubmitRequest,
} from "@lcode/contracts";
import {
  readWorkflowOrchestrationAdvice,
  workflowOrchestrationAdviceBundleSchema,
  workflowScriptFingerprint,
} from "@lcode/shared/lcode-protocol-v4";
import type { ToolExecutionContext } from "../types.js";
import { createWorkflowToolEntry } from "./create-workflow.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import { resolveCreateWorkflowInput } from "./create-workflow-source.js";
import { resolveAmendWorkflowInput } from "./amend-workflow-resolve.js";
import { workflowAdviceOfAnalysis } from "./workflow-script-advice.js";

const SCRIPT = [
  'phase("Investigate");',
  'const service = agent("Service");',
  'const ui = agent("UI");',
  'const tests = agent("Tests");',
  'await service.ask("Inspect service");',
  'const uiWork = ui.ask("Inspect UI");',
  'const testWork = tests.ask("Inspect tests");',
  "return await Promise.all([uiWork, testWork]);",
].join("\n");

const FORGED = {
  scriptHash: workflowScriptFingerprint(SCRIPT),
  items: [
    {
      code: "await-before-later-asks",
      line: 999,
      column: 1,
      waitingOn: [{ line: 999, column: 1 }],
      delayed: [{ line: 999, column: 1 }],
      message: "forged",
    },
  ],
};

for (const kind of ["create", "amend"] as const) {
  test(`${kind} derives bounded advice before confirmation and submits the unchanged script`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "lcode-advice-"));
    const submitted: Array<DynamicWorkflowRunSubmitRequest | DynamicWorkflowRunAmendRequest> = [];
    const port = {
      getTask: async () => ({ runStatus: "completed", parentSessionId: "another-session" }),
      getScript: async () => "return 0;",
      submit: async (request: DynamicWorkflowRunSubmitRequest) => {
        submitted.push(request);
        return { runId: "new-run" };
      },
      amend: async (request: DynamicWorkflowRunAmendRequest) => {
        submitted.push(request);
        return { ok: true, runId: "new-run" };
      },
    } as DynamicWorkflowRunPort;
    try {
      const input = { script: SCRIPT, orchestration_advice: FORGED };
      const resolved =
        kind === "create"
          ? await resolveCreateWorkflowInput(input, cwd)
          : await resolveAmendWorkflowInput(
              { ...input, run_id: "predecessor" },
              { workingDirectory: cwd, dynamicWorkflowRunPort: port },
            );
      assert.equal(resolved.result, true);
      if (!resolved.result) return;
      const advice = readWorkflowOrchestrationAdvice(resolved.input);
      assert.equal(advice.length, 1);
      assert.equal(advice[0]?.line, 5, "model-supplied advice is overwritten by script facts");
      const entry = kind === "create" ? createWorkflowToolEntry : amendWorkflowToolEntry;
      const gate = entry.prepareApproval?.(resolved.input);
      assert.equal(gate?.gate, "ask", "advice never bypasses or blocks approval");
      assert.ok(gate?.gate === "ask");
      assert.equal(gate.display?.kind, "create_workflow");
      assert.equal(
        Object.hasOwn(gate.display ?? {}, "orchestrationAdvice"),
        false,
        "the strict legacy display shape stays frozen",
      );
      assert.deepEqual(submitted, []);
      const output = CreateWorkflowOutputSchema.parse(
        await entry.handler(resolved.input, {
          toolCallId: "tool",
          traceId: "trace",
          sessionId: "session",
          workingDirectory: cwd,
          workspaceRoot: cwd,
          abortSignal: new AbortController().signal,
          dynamicWorkflowRunPort: port,
        } as ToolExecutionContext),
      );
      assert.equal(output.ok, true);
      assert.deepEqual(output.diagnostics, []);
      assert.deepEqual(output.orchestrationAdvice, advice);
      assert.match(output.response, /Non-blocking orchestration advice/u);
      assert.match(String(entry.formatModelContent?.(output)), /L5:C1/u);
      assert.equal(submitted.length, 1);
      assert.equal(submitted[0]?.scriptText, SCRIPT);
      assert.equal(submitted[0]?.maxConcurrency, undefined);
      assert.equal(Object.hasOwn(submitted[0] ?? {}, "orchestrationAdvice"), false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("hook-modified script suppresses stale confirmation advice and handler recomputes", async () => {
  const resolved = await resolveCreateWorkflowInput({ script: SCRIPT }, ".");
  assert.equal(resolved.result, true);
  if (!resolved.result) return;
  assert.equal(readWorkflowOrchestrationAdvice(resolved.input).length, 1);
  const modified = { ...(resolved.input as object), script: "return 1;", path: "fixture.dwf.ts" };
  assert.deepEqual(readWorkflowOrchestrationAdvice(modified), []);
  const output = await createWorkflowToolEntry.handler(modified, {
    workingDirectory: ".",
    abortSignal: new AbortController().signal,
  } as ToolExecutionContext);
  assert.equal(output.orchestrationAdvice, undefined);
  assert.equal(output.ok, true);
});

test("metadata scripts retain body locations in raw and file locations in tool text", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lcode-advice-lines-"));
  const path = join(cwd, "inspect.dwf.ts");
  const header =
    "/* lcode-workflow\nwhenToUse: Inspect interfaces\ndescription: Inspect interfaces\n*/\n";
  try {
    await writeFile(path, header + SCRIPT, "utf8");
    for (const entry of [createWorkflowToolEntry, amendWorkflowToolEntry]) {
      const input = entry === createWorkflowToolEntry ? { path } : { path, run_id: "old" };
      const resolved = await entry.resolveInput?.(input, { workingDirectory: cwd });
      assert.ok(resolved?.result);
      if (!resolved.result) return;
      assert.equal(readWorkflowOrchestrationAdvice(resolved.input)[0]?.line, 5);
      const output = await entry.handler(resolved.input, {
        workingDirectory: cwd,
        abortSignal: new AbortController().signal,
      } as ToolExecutionContext);
      assert.match(output.response as string, /inspect\.dwf\.ts:L9:C1/u);
      assert.equal(output.ok, true);
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("clean script strips forged advice and model-facing parameters never expose it", async () => {
  const clean = await resolveCreateWorkflowInput(
    { script: "return 1;", orchestration_advice: FORGED },
    ".",
  );
  assert.ok(clean.result);
  if (!clean.result) return;
  assert.deepEqual(readWorkflowOrchestrationAdvice(clean.input), []);
  assert.equal(Object.hasOwn(clean.input as object, "orchestration_advice"), false);
  for (const entry of [createWorkflowToolEntry, amendWorkflowToolEntry]) {
    assert.equal(Object.hasOwn(entry.inputSchema.properties ?? {}, "orchestration_advice"), false);
  }
});

test("malformed authored advice is stripped before either resolver validates runtime facts", async () => {
  const malicious = { script: SCRIPT, orchestration_advice: { items: "not a real bundle" } };
  for (const resolved of [
    await resolveCreateWorkflowInput(malicious, "."),
    await resolveAmendWorkflowInput({ ...malicious, run_id: "old" }, { workingDirectory: "." }),
  ]) {
    assert.ok(resolved.result);
    if (!resolved.result) return;
    assert.equal(readWorkflowOrchestrationAdvice(resolved.input)[0]?.line, 5);
  }
});

test("advice projection caps item count but never truncates dependency groups into false facts", () => {
  const item = { ...FORGED.items[0]!, code: "await-before-later-asks" as const };
  const bounded = workflowAdviceOfAnalysis({
    ok: true,
    diagnostics: [],
    declaredArtifacts: [],
    orchestrationAdvice: Array.from({ length: 6 }, (_, index) => ({ ...item, line: index + 1 })),
  });
  assert.equal(bounded.length, 5);
  assert.deepEqual(
    workflowAdviceOfAnalysis({
      ok: true,
      diagnostics: [],
      declaredArtifacts: [],
      orchestrationAdvice: [
        { ...item, waitingOn: Array.from({ length: 9 }, () => ({ line: 1, column: 1 })) },
      ],
    }),
    [],
  );
});

test("CLI Zod3 and shared Zod4 agree on the bounded advice contract", async () => {
  const { WorkflowOrchestrationAdviceBundleSchema } = await import("@lcode/contracts");
  const invalid = [
    { ...FORGED, items: [{ ...FORGED.items[0], line: 0 }] },
    { ...FORGED, items: Array.from({ length: 6 }, () => FORGED.items[0]) },
    { ...FORGED, items: [{ ...FORGED.items[0], message: "x".repeat(1025) }] },
    { ...FORGED, items: [{ ...FORGED.items[0], code: "unknown" }] },
    { ...FORGED, unexpected: true },
  ];
  for (const payload of [FORGED, ...invalid]) {
    assert.equal(
      WorkflowOrchestrationAdviceBundleSchema.safeParse(payload).success,
      workflowOrchestrationAdviceBundleSchema.safeParse(payload).success,
    );
  }
});
