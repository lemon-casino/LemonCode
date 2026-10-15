import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { AgentStderrCollector } from "./agentStderrCollector.js";
import {
  LCODE_PROCESS_DIAGNOSTIC_PREFIX,
  parseLCodeProcessDiagnostic,
} from "@lcode/shared/process-diagnostic";

test("stderr preserves fragmented UTF-8 diagnostic frames and recovers after an oversized plain line", async () => {
  const input = new PassThrough();
  const lines: string[] = [];
  const collector = new AgentStderrCollector(input, (line) => lines.push(line));
  const diagnostic = {
    version: 1,
    errorId: "00000000-0000-4000-8000-000000000001",
    kind: "uncaughtException",
    origin: "uncaughtException",
    name: "Error",
    message: "中文\u2028保留",
    occurredAt: 1,
  };
  const bytes = Buffer.from(LCODE_PROCESS_DIAGNOSTIC_PREFIX + JSON.stringify(diagnostic) + "\n");
  input.write("x".repeat(200_000) + "\n");
  for (let offset = 0; offset < bytes.length; offset += 7)
    input.write(bytes.subarray(offset, offset + 7));
  input.end("last line");
  await collector.waitForDrain();
  assert.ok(lines[0]!.length <= 128 * 1024);
  assert.equal(parseLCodeProcessDiagnostic(lines[1]!)?.message, diagnostic.message);
  assert.equal(lines.at(-1), "last line");
});
