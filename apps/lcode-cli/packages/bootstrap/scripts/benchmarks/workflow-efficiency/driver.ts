import { inspectWorkflowModelFailure } from "@lcode/adapters/model";
import {
  ModelRetryBudget,
  runWithModelInvocationContext,
  type Model,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
} from "@lcode/contracts";
import {
  InMemoryJournalStore,
  WorkflowError,
  type AskMessage,
  type InstanceRef,
  type WorkflowDriver,
  type WorkflowReportSink,
} from "@lcode/dynamic-workflow";
import {
  getWorkflowConcurrencyGovernor,
  workflowConcurrencyKey,
} from "../../../src/app/workflow-concurrency-governor.js";
import { ArmMetrics, safeReason } from "./metrics.js";
import { OUTPUT_CAP, sha256, validResult, type Fixture, type TaskId } from "./fixtures.js";

export interface DriverOptions {
  model: Model;
  fixture: Fixture;
  runId: string;
  signal: AbortSignal;
  metrics: ArmMetrics;
  sink(): WorkflowReportSink;
}

export function createBenchmarkDriver(options: DriverOptions) {
  const { model, fixture, runId, metrics } = options;
  const journal = new InMemoryJournalStore();
  const governor = getWorkflowConcurrencyGovernor();
  const controllers = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();
  const admission: ModelRequestAdmission = {
    tryAcquire: ({ model: target }) => governor.tryAdmit(runId, workflowConcurrencyKey(target)),
    acquire: async ({ model: target, signal }) => {
      const key = workflowConcurrencyKey(target);
      return governor.tryAdmit(runId, key) ?? governor.admit(runId, key, signal ?? options.signal);
    },
  };
  const unsubscribe = governor.subscribe(runId, (change) =>
    options.sink().concurrencyChanged(change),
  );
  let disposed = false;

  function network(instance: InstanceRef, event: ModelNetworkStatusEvent): void {
    metrics.network(instance.siteId as TaskId, event);
    if (event.type === "model_request_queued")
      options.sink().askWaiting(instance, { cause: "slot" });
    if (event.type === "model_request_started") options.sink().askExecuting(instance);
    if (event.type === "model_retry_scheduled")
      options.sink().askWaiting(instance, {
        cause: "backoff",
        reason: safeReason(event.reason),
        attempt: event.nextAttempt,
        delayMs: event.delayMs,
        retryAfterMs: event.retryAfterMs,
      });
  }

  async function execute(instance: InstanceRef, message: AskMessage, local: AbortController) {
    const taskId = instance.siteId as TaskId;
    const task = metrics.task(taskId);
    const signal = AbortSignal.any([local.signal, options.signal]);
    task.requestCallAtMs = metrics.elapsed();
    task.promptSha256 = sha256(message.instructions);
    metrics.logicalRequests += 1;
    let text = "";
    let finished = false;
    try {
      await runWithModelInvocationContext(
        {
          metadata: {
            traceId: runId,
            queryId: `${runId}-${taskId}`,
            requestId: `${runId}-${taskId}-request`,
            querySource: "synthetic_workflow_efficiency",
          },
          modelRequestSessionType: "other",
          modelRetryBudget: ModelRetryBudget.Unbounded,
          modelRequestAdmission: admission,
          statusSink: { publish: (event) => network(instance, event) },
        },
        async () => {
          for await (const event of model.streamText({
            messages: [{ role: "user", content: message.instructions }],
            tools: [],
            options: { maxOutputTokens: OUTPUT_CAP },
            abortSignal: signal,
          })) {
            if (event.type === "text_delta") {
              task.firstTextAtMs ??= metrics.elapsed();
              text += event.text;
            } else if (event.type === "finish") finished = true;
            else if (event.type === "error") throw event.error;
            else if (event.type === "tool_call") throw new Error("unexpected_tool");
          }
        },
      );
      if (!finished) throw new Error("incomplete_stream");
      signal.throwIfAborted();
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        throw new Error("invalid_json");
      }
      const validationStart = performance.now();
      const valid = validResult(fixture, taskId, value);
      task.validationMs = performance.now() - validationStart;
      // 验收不重试：否则新旧两臂逻辑请求数量会因额外修复轮而变，失败必须计入样本。
      if (!valid) throw new Error("validation_failed");
      task.validated = true;
      options.sink().askProgress(instance, { turn: 1, toolCalls: 0 });
      const requests = metrics.requests.filter(
        (request) => request.task === taskId && request.startedAtMs !== null,
      );
      if (
        requests.length > 0 &&
        requests.every(
          (request) =>
            request.usage?.totalTokens !== null && request.usage?.totalTokens !== undefined,
        )
      ) {
        options.sink().askStats(instance, {
          tokens: requests.reduce((sum, request) => sum + request.usage!.totalTokens!, 0),
          turns: 1,
          toolCalls: 0,
          worldToolCalls: 0,
        });
      }
      // 完整输出仅留在本臂内存；引擎再次调用相同纯校验器后，node-settled 才是交付时间。
      options.sink().askSubmitAttempted(instance, value);
    } catch (error) {
      const inspected = inspectWorkflowModelFailure(error);
      const localReason = error instanceof Error ? error.message : undefined;
      task.failureReason = options.signal.aborted
        ? "arm_timeout"
        : signal.aborted
          ? "cancelled"
          : inspected
            ? safeReason(inspected.reason)
            : safeReason(localReason);
      if (inspected?.policy.decision === "stop") {
        options.sink().stopRun(new WorkflowError("ProviderStop", task.failureReason));
      } else {
        options
          .sink()
          .askFailed(
            instance,
            new WorkflowError(
              task.failureReason === "validation_failed" || task.failureReason === "invalid_json"
                ? "ValidationFailed"
                : "DriverError",
              task.failureReason,
            ),
          );
      }
    } finally {
      text = "";
      controllers.delete(instance.siteId);
    }
  }

  const driver: WorkflowDriver = {
    journal,
    emit: (event) => metrics.engine(event),
    // SessionRef 仅为 boundary-B 匿名标识；不创建 AgentRuntime、真实会话、数据库或历史。
    createActorSession: async (actor) => ({ id: `${runId}-${actor.siteId}` }),
    startAsk: (_session, instance, message) => {
      const local = new AbortController();
      controllers.set(instance.siteId, local);
      const job = execute(instance, message, local);
      pending.add(job);
      void job.finally(() => pending.delete(job));
    },
    respondToSubmit: (instance, verdict) => {
      if (verdict.kind !== "accept")
        queueMicrotask(() =>
          options
            .sink()
            .askFailed(instance, new WorkflowError("ValidationFailed", "validation_failed")),
        );
    },
    cancelAsk: (instance) => controllers.get(instance.siteId)?.abort(new Error("cancelled")),
    executeWorldRead: async () => {
      throw new WorkflowError("DriverError", "world_access_disabled");
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      for (const controller of controllers.values()) controller.abort(new Error("cancelled"));
    },
  };
  return {
    driver,
    drain: () => Promise.allSettled(pending),
    publicGovernorSnapshot: () => {
      const snapshot = governor.snapshot(workflowConcurrencyKey(model));
      return snapshot
        ? {
            ceiling: snapshot.ceiling,
            cap: snapshot.cap,
            inFlight: snapshot.inFlight,
            waiters: snapshot.waiters,
            epoch: snapshot.epoch,
          }
        : null;
    },
  };
}
