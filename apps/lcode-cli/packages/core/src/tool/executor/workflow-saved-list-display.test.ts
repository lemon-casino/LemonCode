import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
  LIST_SAVED_WORKFLOWS_TOOL_NAME,
  ListSavedWorkflowsOutputSchema,
  parseCompletedToolPartMetadata,
  savedWorkflowListToolResultDisplayPayloadSchema,
  toolResultDisplayPayloadSchema,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS,
  type ListSavedWorkflowsOutput,
  type SavedWorkflowEntry,
} from "@lcode/contracts";
import {
  toolCallDisplaySchema,
  toolCallSavedWorkflowListDisplaySchema,
} from "@lcode/shared/lcode-protocol-v4";
import { createWorkflowObservationDisplay } from "./workflow-observation-display.js";

const truncationSuffix = "\n...[truncated]";

function workflow(index = 0): SavedWorkflowEntry {
  const scope = index % 2 === 0 ? "global" : "project";
  return {
    name: `template-${index}`,
    description: `Template ${index}`,
    whenToUse: `Use template ${index}`,
    scope,
    path: `${scope}/template-${index}.dwf.ts`,
  };
}

function args(count: number) {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `arg-${count - index}`,
      { type: "string" as const, description: "Input", required: true },
    ]),
  );
}

function assertCompatible(output: ListSavedWorkflowsOutput) {
  ListSavedWorkflowsOutputSchema.parse(output);
  const original = structuredClone(output);
  const display = createWorkflowObservationDisplay(LIST_SAVED_WORKFLOWS_TOOL_NAME, output);
  assert.deepEqual(output, original, "the display projection must not mutate the source list");
  assert.ok(display?.kind === "saved_workflow_list");
  assert.deepEqual(savedWorkflowListToolResultDisplayPayloadSchema.parse(display), display);
  assert.deepEqual(toolResultDisplayPayloadSchema.parse(display), display);
  assert.deepEqual(toolCallSavedWorkflowListDisplaySchema.parse(display), display);
  assert.deepEqual(toolCallDisplaySchema.parse(display), display);
  const metadata = JSON.parse(
    JSON.stringify({ schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION, display }),
  );
  assert.deepEqual(parseCompletedToolPartMetadata(metadata)?.display, metadata.display);
  return display;
}

function assertBoundedText(actual: string | undefined, source: string, maxBytes: number): void {
  assert.ok(actual !== undefined);
  assert.ok(Buffer.byteLength(actual, "utf8") <= maxBytes);
  assert.equal(actual.isWellFormed(), true);
  assert.equal(Buffer.from(actual, "utf8").toString("utf8"), actual);
  if (Buffer.byteLength(source, "utf8") <= maxBytes) {
    assert.equal(actual, source);
    return;
  }
  assert.ok(actual.endsWith(truncationSuffix));
  const prefix = actual.slice(0, -truncationSuffix.length);
  assert.ok(source.startsWith(prefix));
  const next = Array.from(source.slice(prefix.length))[0];
  assert.ok(next);
  assert.ok(Buffer.byteLength(prefix + next + truncationSuffix, "utf8") > maxBytes);
}

test("saved list preserves a genuine empty result without a truncation flag", () => {
  for (const output of [{ workflows: [] }, { workflows: [], invalid: [] }]) {
    assert.deepEqual(assertCompatible(output), { kind: "saved_workflow_list", workflows: [] });
  }
});

test("saved list retains invalid-only results and their order without inventing a list limit", () => {
  const invalid = Array.from({ length: WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS + 1 }, (_, index) => ({
    path: `project/broken-${index}.dwf.ts`,
    reason: `Invalid metadata ${index}`,
  }));
  const display = assertCompatible({ workflows: [], invalid });
  assert.deepEqual(display.workflows, []);
  assert.deepEqual(display.invalid, invalid);
  assert.equal(display.truncated, undefined);
});

test("saved list preserves mixed entries, duplicate names across scopes, and argument order", () => {
  const workflows = [
    { ...workflow(0), name: "shared-name", args: args(3) },
    { ...workflow(1), name: "shared-name" },
  ];
  const invalid = [{ path: "project/broken.dwf.ts", reason: "Cannot read metadata" }];
  const display = assertCompatible({ workflows, invalid });
  assert.deepEqual(
    display.workflows,
    workflows.map(({ args: declarations, ...entry }) => ({
      ...entry,
      argNames: Object.keys(declarations ?? {}),
    })),
  );
  assert.deepEqual(display.invalid, invalid);
  assert.equal(display.truncated, undefined);
});

for (const count of [
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS + 1,
]) {
  test(`saved list bounds ${count} workflows and preserves the retained prefix`, () => {
    const workflows = Array.from({ length: count }, (_, index) => workflow(count - index));
    const display = assertCompatible({ workflows });
    assert.deepEqual(
      display.workflows,
      workflows
        .slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS)
        .map((entry) => ({ ...entry, argNames: [] })),
    );
    assert.equal(
      display.truncated,
      count > WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS ? true : undefined,
    );
  });
}

for (const count of [
  0,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS,
  WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS + 1,
]) {
  test(`saved list bounds ${count} argument names without sorting them`, () => {
    const declarations = args(count);
    const display = assertCompatible({ workflows: [{ ...workflow(), args: declarations }] });
    assert.deepEqual(
      display.workflows[0]?.argNames,
      Object.keys(declarations).slice(0, WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS),
    );
    assert.equal(
      display.truncated,
      count > WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS ? true : undefined,
    );
  });
}

const textFields = [
  { field: "description", limit: WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS },
  { field: "whenToUse", limit: WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS },
  { field: "reason", limit: WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS },
] as const;
for (const { field, limit } of textFields) {
  for (const unit of ["x", "界𐐀"]) {
    for (const extra of [0, 1]) {
      test(`saved list bounds ${field} at ${limit + extra} ${unit === "x" ? "ASCII" : "UTF-8"} bytes`, () => {
        const unitBytes = Buffer.byteLength(unit, "utf8");
        const source =
          unit.repeat(Math.floor(limit / unitBytes)) + "x".repeat((limit % unitBytes) + extra);
        assert.equal(Buffer.byteLength(source, "utf8"), limit + extra);
        const output: ListSavedWorkflowsOutput =
          field === "reason"
            ? { workflows: [], invalid: [{ path: "project/broken.dwf.ts", reason: source }] }
            : { workflows: [{ ...workflow(), [field]: source }] };
        const display = assertCompatible(output);
        const actual =
          field === "reason" ? display.invalid?.[0]?.reason : display.workflows[0]?.[field];
        assertBoundedText(actual, source, limit);
        assert.equal(display.truncated, extra > 0 ? true : undefined);
      });
    }
  }
}

test("saved list keeps truncation true when several bounds clip before later short entries", () => {
  const entry = {
    ...workflow(),
    description: "界𐐀".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS),
    whenToUse: "界𐐀".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS),
    args: args(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS + 1),
  };
  const reason = "界𐐀".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS);
  const display = assertCompatible({
    workflows: [
      entry,
      ...Array.from({ length: WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS }, (_, index) =>
        workflow(index + 1),
      ),
    ],
    invalid: [
      { path: "project/broken.dwf.ts", reason },
      { path: "global/broken.dwf.ts", reason: "Invalid metadata" },
    ],
  });
  assert.equal(display.workflows.length, WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS);
  assert.equal(display.workflows[0]?.argNames.length, WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS);
  assertBoundedText(
    display.workflows[0]?.description,
    entry.description,
    WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  );
  assertBoundedText(
    display.workflows[0]?.whenToUse,
    entry.whenToUse,
    WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS,
  );
  assertBoundedText(
    display.invalid?.[0]?.reason,
    reason,
    WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS,
  );
  assert.equal(display.invalid?.[1]?.reason, "Invalid metadata");
  assert.equal(display.truncated, true);
});

test("malformed saved list output is not converted to an empty display", () => {
  for (const output of [
    null,
    { workflows: "not-an-array" },
    { workflows: [workflow(), { ...workflow(1), scope: "unknown" }] },
    { workflows: [{ ...workflow(), unknown: true }] },
    { workflows: [], invalid: [{ path: "project/broken.dwf.ts" }] },
  ]) {
    assert.equal(
      createWorkflowObservationDisplay(LIST_SAVED_WORKFLOWS_TOOL_NAME, output),
      undefined,
    );
  }
});

test("CLI and shared saved list schemas reject oversized and unknown fields rather than stripping them", () => {
  const row = { ...workflow(), argNames: [] };
  const base = { kind: "saved_workflow_list", workflows: [row] };
  for (const candidate of [
    { ...base, unknown: true },
    { ...base, workflows: [{ ...row, unknown: true }] },
    {
      ...base,
      invalid: [{ path: "project/broken.dwf.ts", reason: "Bad metadata", unknown: true }],
    },
    {
      ...base,
      workflows: Array.from({ length: WORKFLOW_OBSERVATION_DISPLAY_MAX_RUNS + 1 }, () => row),
    },
    {
      ...base,
      workflows: [
        { ...row, argNames: Object.keys(args(WORKFLOW_OBSERVATION_DISPLAY_MAX_ARGS + 1)) },
      ],
    },
    {
      ...base,
      workflows: [
        { ...row, description: "x".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS + 1) },
      ],
    },
    {
      ...base,
      workflows: [
        { ...row, whenToUse: "x".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_META_CHARS + 1) },
      ],
    },
    {
      ...base,
      invalid: [
        {
          path: "project/broken.dwf.ts",
          reason: "x".repeat(WORKFLOW_OBSERVATION_DISPLAY_MAX_LOG_CHARS + 1),
        },
      ],
    },
  ]) {
    assert.equal(
      savedWorkflowListToolResultDisplayPayloadSchema.safeParse(candidate).success,
      false,
    );
    assert.equal(toolCallSavedWorkflowListDisplaySchema.safeParse(candidate).success, false);
    assert.equal(
      parseCompletedToolPartMetadata({
        schemaVersion: COMPLETED_TOOL_PART_METADATA_SCHEMA_VERSION,
        display: candidate,
      }),
      undefined,
    );
  }
});
