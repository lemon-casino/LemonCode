import { WorkflowEngine, WorkflowError, type AskSpec } from "@lcode/dynamic-workflow";
import { resolveWorkflowConcurrencyCeiling } from "../../../src/app/workflow-concurrency-ceiling.js";
import {
  ARM_TIMEOUT_MS,
  CLEANUP_TIMEOUT_MS,
  SELECTION,
  TASK_IDS,
  canonical,
  fixtureFingerprints,
  makeFixture,
  newEarlyParallel,
  oldSerial,
  validResult,
  type Arm,
  type Fixture,
  type TaskId,
} from "./fixtures.js";
import { createBenchmarkDriver } from "./driver.js";
import { ArmMetrics, safeReason, type ArmResult } from "./metrics.js";
import { prepareProvider } from "./provider.js";
import { runtimeProvenance } from "./provenance.js";

interface WorkerCommand {
  type: "start";
  pair: number;
  arm: Arm;
  preflightOnly?: boolean;
}
interface SafeEnvelope {
  type: "ready" | "result" | "failure";
  value: unknown;
}

function send(message: SafeEnvelope): void {
  process.send?.(message);
}

function isTask(value: unknown): value is TaskId {
  return typeof value === "string" && TASK_IDS.includes(value as TaskId);
}

export function validator(fixture: Fixture) {
  return (schema: unknown, value: unknown) => {
    const task = (schema as { task?: unknown } | null)?.task;
    return isTask(task) && validResult(fixture, task, value)
      ? []
      : [{ path: "$", expected: "exact synthetic task result", got: "mismatch" }];
  };
}

async function runArm(command: WorkerCommand): Promise<void> {
  const { pair, arm } = command;
  const fixture = makeFixture(pair);
  const prepared = await prepareProvider();
  const provenance = await runtimeProvenance();
  const ceiling = resolveWorkflowConcurrencyCeiling();
  const preparation = {
    ...provenance,
    ...prepared.publicSettings,
    engineMaxConcurrency: ceiling,
    governorInitialCeiling: ceiling,
    governorScope: "fresh_benchmark_process_per_arm",
    retryBudget: "production_workflow_unbounded_with_arm_abort",
    armTimeoutMs: ARM_TIMEOUT_MS,
    stageFingerprints: fixtureFingerprints(fixture),
  };
  // ready 先经 IPC 落匿名报告，收到 go 后才允许任何真实请求。
  send({ type: "ready", value: { pair, arm, preparation } });
  if (command.preflightOnly) return;
  await new Promise<void>((resolve) =>
    process.once("message", (message: unknown) => {
      if ((message as { type?: string } | null)?.type === "go") resolve();
      else throw new Error("worker_protocol_error");
    }),
  );

  const controller = new AbortController();
  const metrics = new ArmMetrics(performance.now());
  let engine!: WorkflowEngine;
  const runId = `synthetic-pair-${pair}-${arm}`;
  const boundary = createBenchmarkDriver({
    model: prepared.model,
    fixture,
    runId,
    signal: controller.signal,
    metrics,
    sink: () => engine,
  });
  const askSpecs = new Map<string, AskSpec>(
    TASK_IDS.map((task) => [task, { typed: true, schema: { task } }]),
  );
  engine = new WorkflowEngine({
    runId,
    driver: boundary.driver,
    caps: { maxConcurrency: ceiling },
    askSpecs,
    validate: validator(fixture),
    launch: {
      inputId: runId,
      subagentModelProvenance: "runModel",
      subagentSelection: SELECTION,
    },
  });
  const actors = Object.fromEntries(
    TASK_IDS.map((task) => [task, engine.createActor(`actor-${task}`, task)]),
  );
  const timer = setTimeout(() => {
    controller.abort(new Error("arm_timeout"));
    engine.stop("interrupted", new WorkflowError("Interrupted", "arm_timeout"));
  }, ARM_TIMEOUT_MS);
  let failureReason: string | null = null;
  const workflow = (arm === "A" ? oldSerial : newEarlyParallel)(
    {
      ask: (task, prompt) => engine.ask(task, actors[task]!, prompt),
    },
    fixture,
  )
    .then((value) => {
      if (!validResult(fixture, "C", value)) throw new Error("validation_failed");
      engine.complete({ validated: true });
    })
    .catch((error: unknown) => {
      failureReason = controller.signal.aborted
        ? "arm_timeout"
        : safeReason(
            metrics.tasks.find((task) => task.failureReason && task.failureReason !== "cancelled")
              ?.failureReason ?? (error instanceof Error ? error.message : undefined),
          );
      engine.fail(new WorkflowError("DriverError", failureReason));
    });
  const settlement = await engine.settled;
  clearTimeout(timer);
  await workflow;
  const snapshot = metrics.snapshot();
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const cleanupCompleted = await Promise.race([
    boundary.drain().then(() => true),
    new Promise<false>((resolve) => {
      cleanupTimer = setTimeout(() => resolve(false), CLEANUP_TIMEOUT_MS);
    }),
  ]);
  clearTimeout(cleanupTimer);
  if (!cleanupCompleted) failureReason = "cleanup_timeout";
  if (controller.signal.aborted) failureReason = "arm_timeout";
  const success =
    settlement.status === "completed" &&
    snapshot.acceptedTasks === 3 &&
    snapshot.logicalRequests === 3 &&
    snapshot.cachedNodes === 0 &&
    cleanupCompleted;
  const result: ArmResult = {
    pair,
    arm,
    success,
    failureReason: success ? null : (failureReason ?? "unknown"),
    engineStatus: settlement.status,
    cleanupCompleted,
    metrics: { ...snapshot, ...metrics.snapshot(), totalMs: snapshot.totalMs },
    preparation: { ...preparation, governorFinal: boundary.publicGovernorSnapshot() },
  };
  send({ type: "result", value: result });
}

// 导入 pure validator 不触发请求；只有 supervisor fork 的 worker 命令可开始离线装配。
if (process.send)
  process.once("message", (message: WorkerCommand) => {
    if (message?.type !== "start" || !["A", "B"].includes(message.arm)) {
      send({ type: "failure", value: { failureReason: "worker_failed" } });
      process.disconnect?.();
      return;
    }
    void runArm(message)
      .catch(() => {
        // 不输出原始 Error、stack、provider body 或配置。
        send({
          type: "failure",
          value: { pair: message.pair, arm: message.arm, failureReason: "worker_failed" },
        });
      })
      .finally(() => {
        process.disconnect?.();
      });
  });

export const samePreparation = (a: unknown, b: unknown) => canonical(a) === canonical(b);
