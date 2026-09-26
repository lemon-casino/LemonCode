import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AmendWorkflowInputSchema,
  type AmendWorkflowInput,
  type DynamicWorkflowRunAmendRequest,
  type DynamicWorkflowRunPort,
} from "@zcode/contracts";
import type { ToolExecutionContext } from "../types.js";
import { amendWorkflowToolEntry } from "./amend-workflow.js";
import {
  applyWorkflowScriptEdits,
  resolveAmendScript,
  validateAmendWorkflowSource,
} from "./amend-workflow-source.js";
import { resolveAmendWorkflowInput } from "./amend-workflow-resolve.js";

test("AmendWorkflow accepts edits as the only revised-script source", () => {
  assert.deepEqual(
    validateAmendWorkflowSource({
      run_id: "run-1",
      edits: [{ find: "const limit = 2", replace: "const limit = 3" }],
    }),
    { result: true },
  );

  const conflict = validateAmendWorkflowSource({
    run_id: "run-1",
    script: "return 1;",
    edits: [{ find: "1", replace: "2" }],
  });
  assert.equal(conflict.result, false);
  if (conflict.result) return;
  assert.match(conflict.message, /at most one revised script source/u);
});

test("script edits apply in order", () => {
  const result = applyWorkflowScriptEdits("const value = 1;\nreturn value;", [
    { find: "const value = 1", replace: "const value = 2" },
    { find: "return value", replace: "return value * 2" },
  ]);

  assert.deepEqual(result, {
    result: true,
    script: "const value = 2;\nreturn value * 2;",
  });
});

test("script edits can target text produced by an earlier edit", () => {
  const result = applyWorkflowScriptEdits("const mode = 'fast';", [
    { find: "'fast'", replace: "'balanced'" },
    { find: "mode = 'balanced'", replace: "mode = 'deep'" },
  ]);

  assert.deepEqual(result, { result: true, script: "const mode = 'deep';" });
});

test("script edits reject a missing fragment without returning a partial script", () => {
  const result = applyWorkflowScriptEdits("const value = 1;", [
    { find: "value = 1", replace: "value = 2" },
    { find: "return value", replace: "return value * 2" },
  ]);

  assert.deepEqual(result, { result: false, reason: "missing", editIndex: 1 });
});

test("script edits reject an ambiguous fragment", () => {
  const result = applyWorkflowScriptEdits("phase('check');\nphase('check');", [
    { find: "phase('check')", replace: "phase('verify')" },
  ]);

  assert.deepEqual(result, {
    result: false,
    reason: "ambiguous",
    editIndex: 0,
    matchCount: 2,
  });
});

test("script edits reject a batch whose final script is unchanged", () => {
  const result = applyWorkflowScriptEdits("const value = 1;", [
    { find: "value = 1", replace: "value = 2" },
    { find: "value = 2", replace: "value = 1" },
  ]);

  assert.deepEqual(result, { result: false, reason: "unchanged" });
});

test("resolveAmendScript expands compact edits from the stored predecessor script", async () => {
  const model: AmendWorkflowInput = {
    run_id: "run-1",
    edits: [{ find: "const rounds = 2", replace: "const rounds = 3" }],
  };
  const port = {
    getScript: async (runId: string) =>
      runId === "run-1" ? "const rounds = 2;\nreturn rounds;" : undefined,
  } as DynamicWorkflowRunPort;

  const result = await resolveAmendScript({
    model,
    cwd: ".",
    port,
    predecessorScriptPath: undefined,
  });

  assert.deepEqual(result, {
    result: true,
    inherited: false,
    fields: { script: "const rounds = 3;\nreturn rounds;" },
  });
});

test("settings-only amendment still inherits the predecessor script", async () => {
  const port = {
    getScript: async () => "const rounds = 2;\nreturn rounds;",
  } as DynamicWorkflowRunPort;

  const result = await resolveAmendScript({
    model: { run_id: "run-1", max_concurrency: 2 },
    cwd: ".",
    port,
    predecessorScriptPath: undefined,
  });

  assert.deepEqual(result, {
    result: true,
    inherited: true,
    fields: { script: "const rounds = 2;\nreturn rounds;" },
  });
});

test("compact edits require a stored predecessor script", async () => {
  const port = { getScript: async () => undefined } as DynamicWorkflowRunPort;
  const result = await resolveAmendScript({
    model: {
      run_id: "legacy-run",
      edits: [{ find: "old", replace: "new" }],
    },
    cwd: ".",
    port,
    predecessorScriptPath: undefined,
  });

  assert.equal(result.result, false);
  if (result.result) return;
  assert.match(result.message, /workflow_amend_script_unavailable/u);
});

test("resolver passes the full amended script downstream without exposing edit commands", async () => {
  const port = {
    getTask: async () => ({
      name: "Run",
      runStatus: "running",
      parentSessionId: "session-1",
    }),
    getScript: async () => "const rounds = 2;\nreturn rounds;",
  } as DynamicWorkflowRunPort;

  const result = await resolveAmendWorkflowInput(
    {
      run_id: "run-1",
      edits: [{ find: "const rounds = 2", replace: "const rounds = 3" }],
    },
    { workingDirectory: ".", dynamicWorkflowRunPort: port, sessionId: "session-1" },
  );

  assert.deepEqual(result, {
    result: true,
    input: {
      run_id: "run-1",
      script: "const rounds = 3;\nreturn rounds;",
      predecessor: {
        name: "Run",
        status: "running",
        owned_by_this_session: true,
      },
    },
  });
});

test("resolver rejects an edit conflict before the workflow handler can stop its run", async () => {
  const port = {
    getTask: async () => ({ runStatus: "running" }),
    getScript: async () => "const rounds = 2;\nreturn rounds;",
  } as DynamicWorkflowRunPort;

  const result = await resolveAmendWorkflowInput(
    {
      run_id: "run-1",
      edits: [{ find: "const rounds = 9", replace: "const rounds = 3" }],
    },
    { workingDirectory: ".", dynamicWorkflowRunPort: port },
  );

  assert.equal(result.result, false);
  if (result.result) return;
  assert.match(result.message, /workflow_script_edit_missing/u);
  assert.match(result.message, /nothing was stopped or created/u);
});

test("resolver does not turn an inherited session snapshot into an explicit run model", async () => {
  const sessionSelection = {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "high", speed: "fast" },
  } as const;
  const port = {
    getTask: async () => ({
      name: "Inherited",
      runStatus: "running",
      parentSessionId: "session-1",
      subagentSelection: sessionSelection,
      sessionSelection,
    }),
    getScript: async () => "const rounds = 2;\nreturn rounds;",
  } as DynamicWorkflowRunPort;

  const result = await resolveAmendWorkflowInput(
    {
      run_id: "run-1",
      edits: [{ find: "const rounds = 2", replace: "const rounds = 3" }],
    },
    { workingDirectory: ".", dynamicWorkflowRunPort: port, sessionId: "session-1" },
  );

  assert.equal(result.result, true);
  if (!result.result) return;
  const resolved = result.input as Record<string, unknown>;
  assert.equal(resolved.subagent_model, undefined);
  assert.equal(resolved.subagent_selection, undefined);
});

test("compact amendment previews and submits the complete script in a new draft", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "zcode-amend-edits-"));
  const predecessor =
    'phase("Draft");\nconst writer = agent("writer");\nreturn await writer.ask("Draft version one");';
  const revised = predecessor.replace("Draft version one", "Draft version two");
  const inheritedSelection = {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "high", speed: "fast" },
  } as const;
  const inheritedOverrides = [
    {
      name: "writer",
      selection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "low", speed: "standard" },
      },
    },
  ] as const;
  let submitted: DynamicWorkflowRunAmendRequest | undefined;
  const port = {
    getTask: async () => ({
      name: "Draft",
      runStatus: "running",
      parentSessionId: "session-1",
      subagentModel: "provider-a/model-a$high",
      subagentSelection: inheritedSelection,
      actorModelOverrides: inheritedOverrides,
    }),
    getScript: async () => predecessor,
    amend: async (request: DynamicWorkflowRunAmendRequest) => {
      submitted = request;
      return { ok: true, runId: "run-2", supersededRunId: "run-1" };
    },
  } as DynamicWorkflowRunPort;

  try {
    const resolved = await resolveAmendWorkflowInput(
      {
        run_id: "run-1",
        edits: [{ find: "Draft version one", replace: "Draft version two" }],
      },
      { workingDirectory: cwd, dynamicWorkflowRunPort: port, sessionId: "session-1" },
    );
    assert.equal(resolved.result, true);
    if (!resolved.result) return;
    const runtimeInput = AmendWorkflowInputSchema.safeParse(resolved.input);
    assert.equal(
      runtimeInput.success,
      true,
      runtimeInput.success ? undefined : JSON.stringify(runtimeInput.error.issues),
    );
    assert.equal(amendWorkflowToolEntry.prepareApproval?.(resolved.input).gate, "ask");

    const output = await amendWorkflowToolEntry.handler(resolved.input, {
      toolCallId: "tool-1",
      traceId: "trace-1",
      abortSignal: new AbortController().signal,
      workingDirectory: cwd,
      workspaceRoot: cwd,
      sessionId: "session-1",
      dynamicWorkflowRunPort: port,
    } as ToolExecutionContext);

    assert.equal(output.ok, true);
    assert.equal(output.backgroundTaskId, "run-2");
    assert.equal(submitted?.scriptText, revised);
    assert.deepEqual(submitted?.subagentModel, inheritedSelection);
    assert.deepEqual(submitted?.actorModelOverrides, inheritedOverrides);
    assert.ok(submitted?.scriptPath?.startsWith(join(cwd, ".zcode", "workflow-drafts")));
    assert.equal(await readFile(submitted.scriptPath, "utf8"), revised);

    const clearedInput = { ...(resolved.input as Record<string, unknown>) };
    delete clearedInput.actor_model_overrides;
    submitted = undefined;
    await amendWorkflowToolEntry.handler(clearedInput, {
      toolCallId: "tool-2",
      traceId: "trace-2",
      abortSignal: new AbortController().signal,
      workingDirectory: cwd,
      workspaceRoot: cwd,
      sessionId: "session-1",
      dynamicWorkflowRunPort: port,
    } as ToolExecutionContext);
    assert.equal(submitted?.actorModelOverrides, undefined);
  } finally {
    assert.ok(cwd.startsWith(join(tmpdir(), "zcode-amend-edits-")));
    await rm(cwd, { recursive: true, force: true });
  }
});
