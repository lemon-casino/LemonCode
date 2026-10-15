import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentRuntime } from "@lcode/core";
import { createNodeFileSystemAdapter } from "@lcode/adapters";
import { createSqliteSessionStore } from "@lcode/adapters/storage";
import {
  createInMemorySessionEventStore,
  createSessionId,
  type ProtocolShutdownContext,
} from "@lcode/contracts";
import { createSessionFacade } from "./session-facade.js";
import type { CreateSessionFacadeDeps } from "./session-facade-types.js";
import type { LCodeApp } from "./types.js";
import { createDynamicWorkflowRunService } from "./dynamic-workflow-run-service.js";
import { ProtocolRuntimeResources } from "../lcode-protocol/runtime-resources.js";

const logger: CreateSessionFacadeDeps["logger"] = {
  child: () => logger,
  debug() {},
  info() {},
  warn() {},
  error() {},
};
function facade(runtime: AgentRuntime, overrides: Partial<CreateSessionFacadeDeps> = {}) {
  return createSessionFacade({
    runtime,
    logger,
    configResult: { config: { ui: { locale: "en-US", theme: "system" } } } as never,
    configuredMcpServers: {},
    executionPort: {} as never,
    ownsExecutionPort: false,
    ownsMcpPort: false,
    ownsSessionStore: false,
    sessionStore: {} as never,
    ...overrides,
  } as CreateSessionFacadeDeps);
}
function runtimeFixture() {
  return {
    beginShutdown() {},
    closeBrowserSession: async () => {},
    drainMemoryExtractions: async () => {},
    retainSessionStoreDependentCloseWork() {},
    drainSessionStoreDependentCloseWork: async () => {},
  } as unknown as AgentRuntime;
}
const closeContext: ProtocolShutdownContext = {
  closeId: "original-close",
  origin: "signal",
  signal: "SIGTERM",
  processId: 123,
  requestedAt: 1,
  deadlineAt: 2,
  transportAvailable: true,
};

test("real facade and Protocol owner retry retirement without losing the original App or lease", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-owner-close-retry-"));
  const store = createSqliteSessionStore({ dbPath: join(directory, "fixture.sqlite") });
  const parentSessionId = createSessionId();
  const lease = await store.acquireWorkflowExecutionOwner({
    parentSessionId,
    workspaceKey: directory,
  });
  t.after(async () => {
    lease.release();
    store.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const runtime = new AgentRuntime(
    parentSessionId,
    {
      workingDirectory: directory,
      workspacePath: directory,
      mode: "yolo",
      modelSelection: { providerId: "fixture", modelId: "fixture" },
      mcp: { enabled: false },
      memory: { enabled: false },
      titleGeneration: { enabled: false },
    },
    {
      sessionStore: store,
      eventStore: createInMemorySessionEventStore(),
      modelFactory: () => {
        throw new Error("No model should start");
      },
    },
  );
  let retirements = 0;
  let modelCloses = 0;
  const contexts: Array<ProtocolShutdownContext | undefined> = [];
  const service = createDynamicWorkflowRunService({
    journal: lease.journal,
    parentSessionId,
    fileSystemPort: createNodeFileSystemAdapter(),
    executionPort: {} as never,
    createActorRuntime: () => {
      throw new Error("No actor should start");
    },
    executionOwner: {
      ...lease,
      release() {
        retirements++;
        if (retirements === 1) throw new Error("fixture retirement failed");
        lease.release();
      },
    },
  });
  const session = facade(runtime, {
    sessionStore: store,
    closeModelAdapter: async () => {
      modelCloses++;
    },
    closeDynamicWorkflowRuns: async (context) => {
      contexts.push(context);
      await service.close(context);
    },
  });
  const resources = new ProtocolRuntimeResources(
    () => ({ sessionId: parentSessionId, runtime, close: session.close }) as LCodeApp,
  );
  await resources.create();
  await assert.rejects(resources.close(closeContext));
  await assert.rejects(
    store.acquireWorkflowExecutionOwner({ parentSessionId, workspaceKey: directory }),
    { code: "owner_active" },
  );
  await resources.close({ ...closeContext, closeId: "later-close" });
  assert.equal(retirements, 2);
  assert.equal(modelCloses, 1);
  assert.deepEqual(contexts, [closeContext, closeContext]);
  const successor = await store.acquireWorkflowExecutionOwner({
    parentSessionId,
    workspaceKey: directory,
  });
  successor.release();
});

test("facade retries transient drain failure while successful resources close only once", async () => {
  const runtime = runtimeFixture();
  let drains = 0;
  let executions = 0;
  let stores = 0;
  runtime.drainSessionStoreDependentCloseWork = async () => {
    drains++;
    if (drains === 1) throw new Error("fixture drain failed");
  };
  const session = facade(runtime, {
    ownsExecutionPort: true,
    executionPort: {
      close: async () => {
        executions++;
      },
    } as never,
    ownsSessionStore: true,
    sessionStore: {
      close: () => {
        stores++;
      },
    } as never,
  });
  await assert.rejects(session.close!(), /fixture drain failed/);
  assert.equal(stores, 0);
  await session.close!();
  await session.close!();
  assert.equal(drains, 2);
  assert.equal(executions, 1);
  assert.equal(stores, 1);
});

test("independent resource failures are preserved and only failed resources retry", async () => {
  const runtime = runtimeFixture();
  let executions = 0;
  let mcps = 0;
  let browsers = 0;
  let stores = 0;
  runtime.closeBrowserSession = async () => {
    browsers++;
  };
  const failures = [new Error("fixture execution"), new Error("fixture mcp")];
  const session = facade(runtime, {
    ownsExecutionPort: true,
    executionPort: {
      close: async () => {
        if (++executions === 1) throw failures[0];
      },
    } as never,
    ownsMcpPort: true,
    mcpPort: {
      close: async () => {
        if (++mcps === 1) throw failures[1];
      },
    } as never,
    ownsSessionStore: true,
    sessionStore: {
      close: () => {
        stores++;
      },
    } as never,
  });
  await assert.rejects(
    session.close!(),
    (error) =>
      error instanceof AggregateError &&
      failures.every((failure) => error.errors.includes(failure)),
  );
  assert.equal(stores, 0);
  await session.close!();
  assert.equal(executions, 2);
  assert.equal(mcps, 2);
  assert.equal(browsers, 1);
  assert.equal(stores, 1);
});

test("concurrent close shares in-flight work and store close failure remains retryable", async () => {
  let release!: () => void;
  let workflows = 0;
  let stores = 0;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = facade(runtimeFixture(), {
    closeDynamicWorkflowRuns: async () => {
      workflows++;
      await held;
    },
    ownsSessionStore: true,
    sessionStore: {
      close: () => {
        if (++stores === 1) throw new Error("fixture store close");
      },
    } as never,
  });
  const first = session.close!(closeContext);
  const second = session.close!({ ...closeContext, closeId: "later" });
  const observed = Promise.allSettled([first, second]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(workflows, 1);
  release();
  assert.deepEqual(
    (await observed).map((outcome) => outcome.status),
    ["rejected", "rejected"],
  );
  await session.close!();
  assert.equal(workflows, 1);
  assert.equal(stores, 2);
});

test("late resource rejection during critical drain remains a failure and can retry", async () => {
  let finishWorkflow!: () => void;
  let rejectExecution!: (reason: unknown) => void;
  let observeTimeout!: () => void;
  let executions = 0;
  let stores = 0;
  const timeoutObserved = new Promise<void>((resolve) => {
    observeTimeout = resolve;
  });
  const workflow = new Promise<void>((resolve) => {
    finishWorkflow = resolve;
  });
  const execution = new Promise<void>((_resolve, reject) => {
    rejectExecution = reject;
  });
  const session = facade(runtimeFixture(), {
    closeDynamicWorkflowRuns: () => workflow,
    ownsExecutionPort: true,
    executionPort: {
      close: async () => {
        if (++executions === 1) await execution;
      },
    } as never,
    ownsSessionStore: true,
    sessionStore: {
      close: () => {
        stores++;
      },
    } as never,
    sessionResourceCloseTimeoutMs: 1,
    logger: {
      ...logger,
      warn: (_message, context) => {
        if (context?.event === "session.resource_close.timed_out") observeTimeout();
      },
    },
  });
  const refused = assert.rejects(session.close!(), /fixture late close/);
  await timeoutObserved;
  rejectExecution(new Error("fixture late close"));
  finishWorkflow();
  await refused;
  assert.equal(stores, 0);
  await session.close!();
  assert.equal(executions, 2);
  assert.equal(stores, 1);
});
