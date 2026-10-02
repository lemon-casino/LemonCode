import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent, type TraceContext } from "@lcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../../runtime-task/registry.js";
import type { ExecutableToolCall } from "../types.js";
import { BackgroundTaskTracker } from "./background-tasks.js";
import type { BackgroundTaskSnapshot } from "./background-task-lifecycle.js";
import {
  formatWorkflowTaskNotification,
  buildWorkflowNotificationOriginMeta,
} from "./workflow-task-notification.js";
import type { BackgroundTaskNotificationCommand, ToolExecutorDeps } from "./types.js";

const trace = { traceId: "background-test", sessionId: "background-session" } as TraceContext;

function fixture(overrides: Partial<ToolExecutorDeps> = {}) {
  const registry = new InMemoryRuntimeTaskRegistry();
  const events: SessionEvent[] = [];
  const notifications: BackgroundTaskNotificationCommand[] = [];
  const completed = Promise.withResolvers<void>();
  const deps = {
    sessionId: "background-session",
    runtimeScope: "main",
    runtimeTaskRegistry: registry,
    getWorkingDirectory: () => process.cwd(),
    emitEvent: async (event: SessionEvent) => {
      events.push(event);
      if (event.type === SessionEventType.BackgroundTaskCompleted) completed.resolve();
    },
    enqueueBackgroundTaskNotification: (notification: BackgroundTaskNotificationCommand) => {
      notifications.push(notification);
    },
    ...overrides,
  } as ToolExecutorDeps;
  return {
    deps,
    registry,
    events,
    notifications,
    completed,
    tracker: new BackgroundTaskTracker(deps),
  };
}

function call(name: string, input: Record<string, unknown> = {}): ExecutableToolCall {
  return { id: "background-call", name, input } as ExecutableToolCall;
}

test("Bash cancellation waits for settled execution, duplicate tracking does not enqueue twice", async () => {
  const terminal = Promise.withResolvers<BackgroundTaskSnapshot>();
  let reads = 0;
  const setup = fixture({
    executionPort: {
      getBackgroundTask: async () => {
        reads++;
        return { taskId: "bash-task", status: "cancelled" };
      },
      waitForBackgroundTask: () => terminal.promise,
      cancelBackgroundTask: async () => true,
    } as unknown as ToolExecutorDeps["executionPort"],
  });
  const toolCall = call("Bash", { command: "test-command", description: "test command" });
  const launch = { status: "backgrounded", backgroundTaskId: "bash-task" };
  await setup.tracker.trackBackgroundTask(toolCall, launch, trace, undefined);
  await setup.tracker.trackBackgroundTask(toolCall, launch, trace, undefined);
  assert.equal(reads, 1);
  assert.equal(setup.events.length, 1);
  assert.equal(setup.registry.get("bash-task")?.status, "running");
  terminal.resolve({
    taskId: "bash-task",
    status: "cancelled",
    result: { exitCode: 1 },
  } as BackgroundTaskSnapshot);
  await setup.completed.promise;
  assert.equal(setup.registry.get("bash-task")?.status, "killed");
  assert.equal(setup.registry.get("bash-task")?.notified, true);
  assert.equal(setup.notifications.length, 1);
  assert.match(setup.notifications[0]!.text, /was stopped/);
  assert.equal((setup.events[0]!.payload as { cancellable: boolean }).cancellable, true);
});

test("workflow poller and terminal waiter share one completion claim", async (context) => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const terminal = Promise.withResolvers<BackgroundTaskSnapshot>();
  const polled = Promise.withResolvers<BackgroundTaskSnapshot>();
  let reads = 0;
  const setup = fixture({
    dynamicWorkflowRunPort: {
      getTask: async () =>
        ++reads === 1 ? { taskId: "workflow-task", status: "running" } : polled.promise,
      waitForTask: () => terminal.promise,
      cancel: async () => true,
    } as unknown as ToolExecutorDeps["dynamicWorkflowRunPort"],
  });
  await setup.tracker.trackBackgroundTask(
    call("CreateWorkflow", { name: "test workflow" }),
    {
      status: "backgrounded",
      backgroundTaskId: "workflow-task",
    },
    trace,
    undefined,
  );
  context.mock.timers.tick(1000);
  const snapshot = {
    taskId: "workflow-task",
    status: "completed",
    output: { answer: 42 },
  } as BackgroundTaskSnapshot;
  terminal.resolve(snapshot);
  polled.resolve(snapshot);
  await setup.completed.promise;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(setup.notifications.length, 1);
  assert.equal(
    setup.events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted).length,
    1,
  );
  assert.match(setup.notifications[0]!.text, /&quot;answer&quot;: 42/);
  assert.equal(setup.registry.get("workflow-task")?.resultText, '{\n  "answer": 42\n}');
});

test("notification enqueue failure releases the registry claim without retrying", async () => {
  let attempts = 0;
  const setup = fixture({
    enqueueBackgroundTaskNotification: () => {
      attempts++;
      throw new Error("queue unavailable");
    },
  });
  await setup.tracker.trackBackgroundTask(
    call("Bash", { command: "test-command" }),
    {
      status: "backgrounded",
      backgroundTaskId: "lost-task",
    },
    trace,
    undefined,
  );
  assert.equal(attempts, 1);
  assert.equal(setup.registry.get("lost-task")?.notified, false);
  assert.equal(setup.registry.get("lost-task")?.status, "lost");
});

test("superseded workflow claims completion but does not enqueue a model turn", async () => {
  const setup = fixture({
    dynamicWorkflowRunPort: {
      getTask: async () => ({
        taskId: "superseded",
        status: "cancelled",
        runStatus: "stopped",
        stopReason: "superseded",
      }),
      cancel: async () => true,
    } as unknown as ToolExecutorDeps["dynamicWorkflowRunPort"],
  });
  await setup.tracker.trackBackgroundTask(
    call("AmendWorkflow"),
    {
      status: "backgrounded",
      backgroundTaskId: "superseded",
    },
    trace,
    undefined,
  );
  assert.equal(setup.registry.get("superseded")?.notified, true);
  assert.equal(setup.notifications.length, 0);
  assert.equal(setup.events.at(-1)?.type, SessionEventType.BackgroundTaskCompleted);
});

test("workflow results never fall back to launch prose and manifests preserve truncation", () => {
  const setup = fixture();
  const toolCall = call("ResumeWorkflowRun", { name: "resume" });
  const snapshot = { taskId: "workflow-task", status: "completed" } as BackgroundTaskSnapshot;
  const text = formatWorkflowTaskNotification(
    setup.deps,
    toolCall,
    "workflow-task",
    "completed",
    snapshot,
    { response: "stale launch text" },
  );
  assert.doesNotMatch(text, /stale launch text/);
  const meta = buildWorkflowNotificationOriginMeta(
    toolCall,
    "workflow-task",
    "completed",
    {
      ...snapshot,
      output: "x".repeat(5000),
      startedAt: new Date(1000),
      completedAt: new Date(2000),
    } as BackgroundTaskSnapshot,
    undefined,
  ).workflowNotification;
  assert.equal(meta?.kind, "terminal");
  assert.ok(meta?.kind === "terminal");
  assert.equal(meta.result?.length, 4000);
  assert.equal(meta.resultTruncated, true);
  assert.equal(meta.durationMs, 1000);
});
