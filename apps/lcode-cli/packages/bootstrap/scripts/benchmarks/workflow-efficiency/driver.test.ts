import assert from "node:assert/strict";
import test from "node:test";
import { getCurrentModelInvocationContext, type Model, type ModelRequest } from "@lcode/contracts";
import { WorkflowEngine, WorkflowError } from "@lcode/dynamic-workflow";
import { createBenchmarkDriver } from "./driver.js";
import { ArmMetrics } from "./metrics.js";
import { makeFixture, TASK_IDS, validResult, type TaskId } from "./fixtures.js";

async function runStub(mode: "success" | "invalid" | "abort") {
  const fixture = makeFixture(1);
  const controller = new AbortController();
  let start!: () => void;
  const started = new Promise<void>((resolve) => {
    start = resolve;
  });
  const model = {
    providerId: "synthetic",
    modelId: "stub",
    async *streamText(request: ModelRequest) {
      const context = getCurrentModelInvocationContext();
      assert.equal(context?.modelRetryBudget, "unbounded");
      assert.equal(context?.modelRequestSessionType, "other");
      assert.equal(request.options?.maxOutputTokens, 5000);
      assert.deepEqual(request.tools, []);
      assert.ok(context?.modelRequestAdmission?.tryAcquire);
      const ticket = context.modelRequestAdmission.tryAcquire({
        model: { providerId: "synthetic", modelId: "stub" },
      });
      assert.ok(ticket);
      try {
        start();
        if (mode === "abort")
          await new Promise<void>((_resolve, reject) => {
            request.abortSignal!.addEventListener(
              "abort",
              () => reject(request.abortSignal!.reason),
              { once: true },
            );
          });
        yield {
          type: "text_delta" as const,
          text: JSON.stringify(mode === "invalid" ? {} : fixture.expected.A),
        };
        yield { type: "finish" as const, finishReason: "stop", usage: {} };
      } finally {
        ticket.release();
      }
    },
  } as unknown as Model;
  let engine!: WorkflowEngine;
  const metrics = new ArmMetrics(performance.now());
  const boundary = createBenchmarkDriver({
    model,
    fixture,
    runId: `test-${mode}`,
    signal: controller.signal,
    metrics,
    sink: () => engine,
  });
  engine = new WorkflowEngine({
    runId: `test-${mode}`,
    driver: boundary.driver,
    caps: { maxConcurrency: 2 },
    askSpecs: new Map(TASK_IDS.map((task) => [task, { typed: true, schema: task }])),
    validate: (schema, value) =>
      validResult(fixture, schema as TaskId, value)
        ? []
        : [{ path: "$", expected: "fixture", got: "mismatch" }],
  });
  const actor = engine.createActor("actor-A", "A");
  const result = engine.ask("A", actor, fixture.prompts.A).then(
    (value) => engine.complete(value),
    () => engine.fail(new WorkflowError("DriverError", "expected_test_failure")),
  );
  await started;
  if (mode === "abort") {
    controller.abort(new Error("arm_timeout"));
    engine.stop("interrupted", new WorkflowError("Interrupted", "arm_timeout"));
  }
  await result;
  const settlement = await engine.settled;
  await boundary.drain();
  assert.equal(boundary.publicGovernorSnapshot()?.inFlight, 0);
  return { settlement, metrics: metrics.snapshot() };
}

test("synthetic driver submits only validated results with production retry and governor admission", async () => {
  const { settlement, metrics } = await runStub("success");
  assert.equal(settlement.status, "completed");
  assert.equal(metrics.logicalRequests, 1);
  assert.equal(metrics.acceptedTasks, 1);
  assert.notEqual(metrics.ttfdMs, null);
  assert.equal(metrics.usage.completeTotals.totalTokens, null);
});

test("validation failures stay failed, without repair requests or false TTFD", async () => {
  const { settlement, metrics } = await runStub("invalid");
  assert.equal(settlement.status, "errored");
  assert.equal(metrics.logicalRequests, 1);
  assert.equal(metrics.acceptedTasks, 0);
  assert.equal(metrics.ttfdMs, null);
});

test("arm abort cancels the request and releases its production governor ticket", async () => {
  const { settlement, metrics } = await runStub("abort");
  assert.equal(settlement.status, "stopped");
  assert.equal(metrics.acceptedTasks, 0);
  assert.equal(metrics.tasks[0]?.failureReason, "arm_timeout");
});
