import assert from "node:assert/strict";
import test from "node:test";
import type {
  Logger,
  ProjectId,
  SessionId,
  SessionStorePort,
  TraceContext,
} from "@zcode/contracts";
import type { AgentRuntime } from "@zcode/core";
import { createSessionFacade } from "./session-facade.js";

function createDeferred(): { promise: Promise<void>; resolve(): void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

test("session close starts resource shutdown but keeps the store open until actor disposal settles", async () => {
  const actorDispose = createDeferred();
  const browserClose = createDeferred();
  const order: string[] = [];
  const runtime = {
    beginShutdown: () => {
      order.push("begin_shutdown");
    },
    closeBrowserSession: async () => {
      order.push("browser_close_started");
      await browserClose.promise;
      order.push("browser_close_settled");
    },
    drainMemoryExtractions: async () => {
      order.push("memory_drained");
    },
    retainSessionStoreDependentCloseWork: () => undefined,
    drainSessionStoreDependentCloseWork: async () => {
      order.push("actor_dispose_started");
      await actorDispose.promise;
      order.push("actor_dispose_settled");
    },
  } as unknown as AgentRuntime;
  const sessionStore = {
    close: () => {
      order.push("store_closed");
    },
  } as unknown as SessionStorePort;
  const logger = {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  } as unknown as Logger;
  const facade = createSessionFacade({
    configResult: { config: { ui: { locale: "en-US", theme: "system" } } } as never,
    configuredMcpServers: {},
    executionPort: {} as never,
    logger,
    loggerFactory: {} as never,
    ownsExecutionPort: false,
    ownsMcpPort: false,
    ownsSessionStore: true,
    prepareResume: async () => undefined,
    prepareUserExecutionBoundary: async () => undefined,
    projectID: "project-close-order" as ProjectId,
    providerRegistry: {} as never,
    resolveUiLocale: () => "en-US",
    runtime,
    sessionId: "session-close-order" as SessionId,
    sessionResourceCloseTimeoutMs: 1,
    sessionStore,
    traceContext: {} as TraceContext,
    untrustedProjectMcpServers: new Set(),
    workingDirectory: ".",
  });

  assert.ok(facade.close);
  const closing = facade.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  assert.equal(order.includes("browser_close_started"), true);
  assert.equal(order.includes("store_closed"), false);

  actorDispose.resolve();
  await closing;

  assert.ok(order.indexOf("begin_shutdown") < order.indexOf("browser_close_started"));
  assert.ok(order.indexOf("browser_close_started") < order.indexOf("actor_dispose_settled"));
  assert.ok(order.indexOf("actor_dispose_settled") < order.indexOf("store_closed"));
  browserClose.resolve();
});

test("session close does not close the store when durable drain fails after a pending sibling", async () => {
  const sibling = createDeferred();
  const drainStarted = createDeferred();
  let storeClosed = false;
  const runtime = {
    beginShutdown: () => undefined,
    closeBrowserSession: async () => undefined,
    drainMemoryExtractions: async () => undefined,
    drainSessionStoreDependentCloseWork: async () => {
      drainStarted.resolve();
      await sibling.promise;
      throw new Error("durable close failed");
    },
    retainSessionStoreDependentCloseWork: () => undefined,
  } as unknown as AgentRuntime;
  const sessionStore = {
    close: () => {
      storeClosed = true;
    },
  } as unknown as SessionStorePort;
  const logger = {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  } as unknown as Logger;
  const facade = createSessionFacade({
    configResult: { config: { ui: { locale: "en-US", theme: "system" } } } as never,
    configuredMcpServers: {},
    executionPort: {} as never,
    logger,
    loggerFactory: {} as never,
    ownsExecutionPort: false,
    ownsMcpPort: false,
    ownsSessionStore: true,
    prepareResume: async () => undefined,
    prepareUserExecutionBoundary: async () => undefined,
    projectID: "project-close-failure" as ProjectId,
    providerRegistry: {} as never,
    resolveUiLocale: () => "en-US",
    runtime,
    sessionId: "session-close-failure" as SessionId,
    sessionStore,
    traceContext: {} as TraceContext,
    untrustedProjectMcpServers: new Set(),
    workingDirectory: ".",
  });

  assert.ok(facade.close);
  const closing = facade.close();
  await drainStarted.promise;
  assert.equal(storeClosed, false);

  sibling.resolve();
  await assert.rejects(closing, /durable close failed/);
  assert.equal(storeClosed, false);
});

test("session close drains work retained by timed-out browser and execution closes", async () => {
  const browserWriter = createDeferred();
  const executionWriter = createDeferred();
  const pending = new Set<Promise<void>>();
  let storeClosed = false;
  const retain = (work: Promise<void>): void => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => undefined,
    );
  };
  const runtime = {
    beginShutdown: () => undefined,
    closeBrowserSession: () => {
      retain(browserWriter.promise);
      return new Promise<void>(() => undefined);
    },
    drainMemoryExtractions: async () => undefined,
    drainSessionStoreDependentCloseWork: async () => {
      while (pending.size > 0) await Promise.allSettled(pending);
    },
    retainSessionStoreDependentCloseWork: retain,
  } as unknown as AgentRuntime;
  const sessionStore = {
    close: () => {
      storeClosed = true;
    },
  } as unknown as SessionStorePort;
  const logger = {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  } as unknown as Logger;
  const facade = createSessionFacade({
    configResult: { config: { ui: { locale: "en-US", theme: "system" } } } as never,
    configuredMcpServers: {},
    executionPort: {
      close: () => {
        retain(executionWriter.promise);
        return new Promise<void>(() => undefined);
      },
    } as never,
    logger,
    loggerFactory: {} as never,
    ownsExecutionPort: true,
    ownsMcpPort: false,
    ownsSessionStore: true,
    prepareResume: async () => undefined,
    prepareUserExecutionBoundary: async () => undefined,
    projectID: "project-close-retained-resource" as ProjectId,
    providerRegistry: {} as never,
    resolveUiLocale: () => "en-US",
    runtime,
    sessionId: "session-close-retained-resource" as SessionId,
    sessionResourceCloseTimeoutMs: 1,
    sessionStore,
    traceContext: {} as TraceContext,
    untrustedProjectMcpServers: new Set(),
    workingDirectory: ".",
  });

  assert.ok(facade.close);
  const closing = facade.close();
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(pending.size, 2);
  assert.equal(storeClosed, false);

  browserWriter.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(storeClosed, false, "execution-owned writer must also keep the store open");
  executionWriter.resolve();
  await closing;
  assert.equal(storeClosed, true);
});
