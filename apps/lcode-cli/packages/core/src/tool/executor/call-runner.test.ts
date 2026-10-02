import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent, type SkillTelemetryMetadata } from "@lcode/contracts";
import { PermissionService } from "../../permission/service.js";
import { ToolRegistryImpl } from "../registry.js";
import type { PersistedReadFileStateMetadata } from "../read-file-state-metadata.js";
import type { ToolEntry } from "../types.js";
import { createToolExecutor } from "./impl.js";
import type { ToolExecutorOptions } from "./types.js";

const readMetadata: PersistedReadFileStateMetadata = {
  schemaVersion: 1,
  tool: "Read",
  path: "test-file",
  content: "test-content",
  isPartialView: false,
  readAtMs: 1000,
  revisionId: "revision",
  mtimeMs: 1000,
  sizeBytes: 12,
};
const skillMetadata: SkillTelemetryMetadata = { qualifiedName: "test-skill" };

function executor(entry: Partial<ToolEntry>) {
  const registry = new ToolRegistryImpl();
  registry.register({
    metadata: { name: "TestTool", readOnly: true, riskLevel: "low", sideEffectScope: "none" },
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    ...entry,
  } as ToolEntry);
  const events: SessionEvent[] = [];
  return {
    events,
    executor: createToolExecutor({
      registry,
      permissionService: new PermissionService(),
      emitEvent: async (event) => {
        events.push(event);
      },
      sessionId: "test-session",
      getWorkingDirectory: () => process.cwd(),
      getWorkspaceRoot: () => process.cwd(),
      getMode: () => "yolo",
    } as ToolExecutorOptions),
  };
}

test("execution context metadata callbacks update the enclosing result owner", async () => {
  const setup = executor({
    handler: async (_input, context) => {
      context.recordReadFileStateMetadata?.(readMetadata);
      context.recordSkillTelemetryMetadata?.(skillMetadata);
      return { done: true };
    },
  });
  const result = await setup.executor.execute({
    id: "test-call",
    name: "TestTool",
    input: {},
  } as never);
  assert.equal(result.success, true);
  assert.equal(result.readFileStateMetadata, readMetadata);
  const terminal = setup.events.find((event) => event.type === SessionEventType.ToolCallResult);
  assert.ok(terminal);
  assert.equal(
    (terminal.payload as { skillMetadata?: SkillTelemetryMetadata }).skillMetadata,
    skillMetadata,
  );
});

test("handler failures preserve skill metadata without retrying", async () => {
  let calls = 0;
  const setup = executor({
    handler: async (_input, context) => {
      calls++;
      context.recordSkillTelemetryMetadata?.(skillMetadata);
      throw new Error("mock handler failure");
    },
  });
  const result = await setup.executor.execute({
    id: "failed-call",
    name: "TestTool",
    input: {},
  } as never);
  assert.equal(result.success, false);
  assert.equal(calls, 1);
  const terminal = setup.events.find((event) => event.type === SessionEventType.ToolCallError);
  assert.ok(terminal);
  assert.equal(
    (terminal.payload as { skillMetadata?: SkillTelemetryMetadata }).skillMetadata,
    skillMetadata,
  );
});

test("invalid tool input emits failure before the handler starts", async () => {
  let calls = 0;
  const setup = executor({
    inputSchema: {
      type: "object",
      required: ["file_path"],
      properties: { file_path: { type: "string" } },
    },
    handler: async () => {
      calls++;
      return {};
    },
  });
  const result = await setup.executor.execute({
    id: "invalid-call",
    name: "TestTool",
    input: {},
  } as never);
  assert.equal(result.success, false);
  assert.equal(calls, 0);
  assert.match(result.error!.message, /required parameter `file_path` is missing/);
  assert.match(result.modelContent as string, /required parameter `file_path` is missing/);
  assert.deepEqual(
    setup.events.map((event) => event.type),
    [SessionEventType.ToolCallError],
  );
});
