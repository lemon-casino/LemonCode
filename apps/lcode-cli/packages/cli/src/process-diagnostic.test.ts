import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { installCliProcessErrorBoundary } from "./process-errors.js";
import { createProcessDiagnostic } from "./process-diagnostic.js";
import { hostAgentProcessExceptionResponseSchema, LCODE_AGENT_PROVIDER } from "@lcode/shared";
import {
  parseLCodeProcessDiagnostic,
  redactLCodeProcessDiagnostic,
  LCODE_PROCESS_DIAGNOSTIC_PREFIX,
} from "@lcode/shared/process-diagnostic";

test("fatal keeps frames behind a huge assertion excerpt, bounded causes and one original ID", () => {
  const target = new EventEmitter();
  let output = "";
  let errorId = "";
  const root = Object.assign(new Error("fixture"), { code: "ERR_ASSERTION" });
  root.stack = `AssertionError: fixture\n${"x".repeat(40_000)}\n    at first (fixture.js:2:1)\n    at last (fixture.js:3:1)`;
  const cause = new Error("cause");
  root.cause = cause;
  cause.cause = root;
  const stop = installCliProcessErrorBoundary({
    target,
    stderr: {
      write: (chunk) => {
        output += chunk;
      },
    },
    onFatal: (_reason, id) => {
      errorId = id;
    },
  });
  target.emit("uncaughtException", root);
  target.emit("unhandledRejection", new Error("secondary"));
  stop();
  const diagnostic = parseLCodeProcessDiagnostic(output.split("\n")[0]!);
  assert.equal(diagnostic?.errorId, errorId);
  assert.equal(diagnostic?.version, 2);
  if (diagnostic?.version !== 2) return assert.fail("expected v2");
  assert.equal(diagnostic.code, "ERR_ASSERTION");
  assert.equal(diagnostic.frames.length, 2);
  assert.match(diagnostic.stack!, /at last/);
  assert.equal(diagnostic.truncated.stackChars, root.stack.length);
  assert.equal(diagnostic.truncated.causes, true);
  assert.equal(diagnostic.causes.length, 1);
  assert.equal(output.split(LCODE_PROCESS_DIAGNOSTIC_PREFIX).length, 2);
  const redacted = redactLCodeProcessDiagnostic(diagnostic, (value) =>
    value.replaceAll("fixture", "[redacted]"),
  );
  assert.ok(!JSON.stringify(redacted).includes("fixture"));
  assert.ok(
    parseLCodeProcessDiagnostic(LCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(redacted)),
  );
});

test("diagnostic v1 remains readable while unknown versions and oversized frames are rejected", () => {
  const frame = {
    version: 1,
    errorId: "00000000-0000-4000-8000-000000000001",
    kind: "uncaughtException",
    origin: "uncaughtException",
    name: "Error",
    message: "fixture",
    occurredAt: 1,
  };
  const parse = (value: unknown) =>
    parseLCodeProcessDiagnostic(LCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(value));
  assert.equal(parse(frame)?.version, 1);
  assert.equal(parse({ ...frame, version: 3 }), undefined);
  assert.equal(parse({ ...frame, stack: "x".repeat(20_000) }), undefined);
});

test("escaped control characters and long cause frames still fit one diagnostic line", () => {
  let error = new Error("\u0001".repeat(4_000));
  const frames = Array.from({ length: 16 }, () => `    at ${"\u0001".repeat(510)}`).join("\n");
  error.stack = frames;
  for (let index = 0; index < 4; index++)
    error = Object.assign(new Error(error.message, { cause: error }), { stack: frames });
  const diagnostic = createProcessDiagnostic(
    "00000000-0000-4000-8000-000000000001",
    "uncaughtException",
    "uncaughtException",
    error,
  );
  assert.ok(
    parseLCodeProcessDiagnostic(LCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic)),
  );
});

test("v2 diagnostic reaches the strict Host IPC schema with the observed bundle identity", () => {
  const event = {
    type: "agent-process-exception",
    pid: 1,
    provider: LCODE_AGENT_PROVIDER,
    workspacePath: "/fixture",
    runtimeGeneration: 1,
    runtimeInstanceId: "fixture-runtime",
    agentEntrySha256: "a".repeat(64),
    diagnostic: createProcessDiagnostic(
      "00000000-0000-4000-8000-000000000001",
      "uncaughtException",
      "uncaughtException",
      Object.assign(new Error("fixture"), { code: "ERR_ASSERTION" }),
    ),
  };
  assert.equal(hostAgentProcessExceptionResponseSchema.safeParse(event).success, true);
  assert.equal(
    hostAgentProcessExceptionResponseSchema.safeParse({ ...event, agentEntrySha256: "invalid" })
      .success,
    false,
  );
});
