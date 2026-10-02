import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ModelTransportKind } from "@lcode/contracts/model";
import type { ResolvedModelTelemetryDescriptor } from "@lcode/contracts/telemetry";
import {
  AgentExecutionTelemetryRuntime,
  NoopAgentExecutionTelemetry,
} from "./agent-trace-runtime.js";
import {
  NOOP_AGENT_TELEMETRY_METRICS,
  type AgentTelemetryMetricRecorder,
} from "./agent-metrics.js";

const execution = {
  actorKind: "main",
  launchSurface: "standalone_cli",
  sessionId: "session-fixture",
  turnId: "turn-fixture",
} as const;
const target: ResolvedModelTelemetryDescriptor = {
  providerId: "fixture",
  providerKind: "openai",
  requestedModel: "fixture-model",
  reasoning: {
    capability: "unknown",
    requestedState: "unknown",
    requestedControl: "unknown",
    effectiveState: "unknown",
    effectiveControl: "unknown",
  },
};

function fixture(t: TestContext, maxActiveWriters = 100) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  const manager = new AsyncLocalStorageContextManager().enable();
  context.setGlobalContextManager(manager);
  const terminals: Parameters<AgentTelemetryMetricRecorder["recordSpanTerminal"]>[] = [];
  const deltas: Parameters<AgentTelemetryMetricRecorder["recordModelTokenDelta"]>[] = [];
  const attempts: Parameters<AgentTelemetryMetricRecorder["recordModelCallAttempts"]>[] = [];
  const details: Parameters<AgentTelemetryMetricRecorder["recordModelAttemptDetail"]>[] = [];
  const drops: Parameters<AgentTelemetryMetricRecorder["recordCreationDrop"]>[] = [];
  const warnings: string[] = [];
  const runtime = new AgentExecutionTelemetryRuntime({
    tracer: provider.getTracer("fixture"),
    maxActiveWriters,
    onWarning: (message) => {
      warnings.push(message);
    },
    metrics: {
      ...NOOP_AGENT_TELEMETRY_METRICS,
      recordSpanTerminal: (...args) => {
        terminals.push(args);
      },
      recordModelTokenDelta: (...args) => {
        deltas.push(args);
      },
      recordModelCallAttempts: (...args) => {
        attempts.push(args);
      },
      recordModelAttemptDetail: (...args) => {
        details.push(args);
      },
      recordCreationDrop: (...args) => {
        drops.push(args);
      },
    },
  });
  t.after(async () => {
    runtime.abandonProcess();
    await provider.shutdown();
    context.disable();
    manager.disable();
  });
  return { runtime, exporter, provider, terminals, deltas, attempts, details, drops, warnings };
}

test("nested writers retain one trace, identity and idempotent terminal cleanup", async (t) => {
  const f = fixture(t);
  f.runtime.updateIdentity({ identityState: "authenticated", userSubjectId: "user-fixture" });
  const turn = f.runtime.startTurn({ context: execution, turnNumber: 1, inputSource: "user" });
  turn.run(() => {
    const step = f.runtime.startStep({ stepId: "step-fixture", stepIndex: 0 });
    step.run(() => {
      const tool = f.runtime.startTool({ registeredToolName: "Bash", toolCallId: "tool-fixture" });
      tool.run(() => {
        tool.markPermissionRequested();
        tool.markPermissionRequested();
        tool.setPermissionDecision("granted");
        const command = tool.startCommand({
          safeName: "git",
          category: "git",
          commandCount: 1,
          sandboxed: true,
        });
        command.run(() => {
          command.markFirstOutput();
          command.markFirstOutput();
          command.finishCompleted();
        });
        tool.finishCompleted();
        tool.finishCancelled("user");
      });
      step.finishCompleted("turn_completed");
    });
    turn.finishCompleted("assistant_message");
  });
  f.runtime.abandonSession(execution.sessionId);
  f.runtime.abandonProcess();
  await f.provider.forceFlush();
  const spans = f.exporter.getFinishedSpans();
  assert.equal(spans.length, 4);
  assert.deepEqual(
    spans.map((span) => span.name),
    ["command_execution", "tool_execution", "agent_step", "agent_turn"],
  );
  const root = spans[3];
  assert.equal(root.attributes["zcode.execution.user_subject_id"], "user-fixture");
  for (let index = 0; index < 3; index += 1) {
    assert.equal(spans[index].spanContext().traceId, root.spanContext().traceId);
    assert.equal(spans[index].parentSpanContext?.spanId, spans[index + 1].spanContext().spanId);
  }
  assert.equal(spans[0].events.filter((event) => event.name === "first_output").length, 1);
  assert.equal(spans[1].events.filter((event) => event.name === "permission_requested").length, 1);
  assert.equal(f.terminals.length, 4);
});

test("capacity drops are throttled and ending a writer immediately frees its slot", async (t) => {
  const f = fixture(t, 1);
  const first = f.runtime.startTurn({ context: execution, turnNumber: 1 });
  f.runtime.startStep({ stepId: "dropped-1", stepIndex: 1 }).finishCompleted("turn_completed");
  f.runtime.startStep({ stepId: "dropped-2", stepIndex: 2 }).finishDiscarded();
  assert.equal(f.warnings.length, 1);
  assert.deepEqual(f.drops, [
    ["agent_step", "process_capacity"],
    ["agent_step", "process_capacity"],
  ]);
  first.finishCompleted();
  const next = f.runtime.startTurn({ context: execution, turnNumber: 2 });
  f.runtime.abandonSession(execution.sessionId);
  next.finishCompleted();
  await f.provider.forceFlush();
  const spans = f.exporter.getFinishedSpans();
  assert.equal(spans.length, 2);
  assert.equal(spans[1].attributes["lcode.agent_turn.abandon_reason"], "session_shutdown");
});

test("model attempt clocks, cumulative token deltas and retry recovery stay writer-owned", async (t) => {
  const f = fixture(t);
  let milliseconds = 10;
  t.mock.method(process.hrtime, "bigint", () => BigInt(milliseconds) * 1_000_000n);
  const call = f.runtime.startCall({
    logicalCallId: "call-fixture",
    operation: "agent_step",
    requested: target,
    streaming: true,
    callCause: "initial",
  });
  const first = call.startAttempt({
    requestId: "request-1",
    attemptNumber: 1,
    maxAttempts: 2,
    attemptCause: "initial",
    target,
    apiOperation: "chat_completions",
    transport: ModelTransportKind.Sse,
  });
  milliseconds = 15;
  first.markFirstProviderEvent();
  milliseconds = 18;
  first.markFirstContent();
  milliseconds = 20;
  first.markFirstText();
  first.markFirstText();
  first.setInputTokens(10);
  first.setInputTokens(10);
  first.setInputTokens(8);
  first.setInputTokens(13);
  first.markStreamStalled(4);
  first.markStreamStalled(7);
  first.markStreamStalled(-1);
  milliseconds = 22;
  first.finishFailed("stream", "network");
  const second = call.startAttempt({
    requestId: "request-2",
    attemptNumber: 2,
    maxAttempts: 2,
    attemptCause: "retry",
    previousRequestId: "request-1",
    retryDelayMs: 5,
    target,
    apiOperation: "chat_completions",
    transport: ModelTransportKind.Sse,
  });
  second.finishCompleted();
  call.finishCompleted();
  call.finishAbandoned("process_shutdown");
  await f.provider.forceFlush();
  assert.deepEqual(
    f.deltas.map((entry) => entry.slice(0, 2)),
    [
      ["input", 10],
      ["input", 0],
      ["input", 3],
    ],
  );
  assert.deepEqual(f.details[0][1], {
    firstContentMs: 8,
    firstProviderEventMs: 5,
    firstTextMs: 10,
    stallCount: 2,
    streamMaxIdleMs: 7,
  });
  assert.equal(f.attempts[0][0], 2);
  assert.equal(f.attempts[0][1].retry_state, "recovered");
  assert.equal(f.terminals.filter((entry) => entry[0] === "model_call").length, 1);
  assert.equal(f.exporter.getFinishedSpans().length, 3);
});

test("causation preserves linked roots versus explicit child parenting", async (t) => {
  const f = fixture(t);
  const turn = f.runtime.startTurn({ context: execution, turnNumber: 1 });
  const causation = turn.captureCausation();
  assert.ok(causation);
  turn.finishCompleted();
  const linked = f.runtime.startTurn({
    context: { ...execution, sessionId: "linked" },
    causation,
    turnNumber: 1,
  });
  const child = f.runtime.startTurn({
    context: { ...execution, sessionId: "child" },
    causation,
    causationMode: "child",
    turnNumber: 1,
  });
  linked.finishCompleted();
  child.finishCompleted();
  await f.provider.forceFlush();
  const spans = f.exporter.getFinishedSpans();
  assert.equal(spans[1].parentSpanContext, undefined);
  assert.equal(spans[1].links[0].context.spanId, causation.spanId);
  assert.equal(spans[1].links[0].attributes?.["zcode.link.relation"], "spawned_by");
  assert.equal(spans[2].parentSpanContext?.spanId, causation.spanId);
  assert.equal(spans[2].spanContext().traceId, causation.traceId);
});

test("Noop telemetry retains entrypoint arity and executes business once", () => {
  const noop = new NoopAgentExecutionTelemetry();
  assert.equal(noop.startTurn.length, 0);
  assert.equal(noop.abandonSession.length, 0);
  let calls = 0;
  assert.equal(
    noop.startTurn().run(() => ++calls),
    1,
  );
});
