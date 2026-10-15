import assert from "node:assert/strict";
import test from "node:test";
import type { SqliteSessionStore } from "@lcode/adapters/storage";
import type { Logger, LogContext } from "@lcode/contracts";
import { cleanupProtocolRuntime } from "./runtime-cleanup.js";

test("cleanup reports bounded redacted causes and a summary correlated to the original fatal", async () => {
  const warnings: LogContext[] = [],
    infos: LogContext[] = [];
  const logger: Logger = {
    child: () => logger,
    debug() {},
    error() {},
    info: (_message, context) => {
      if (context) infos.push(context);
    },
    warn: (_message, context) => {
      if (context) warnings.push(context);
    },
  };
  let storeClosed = false,
    independent = false;
  const error = new Error("fixture failure", { cause: new Error("token=fixture-secret") });
  await assert.rejects(
    cleanupProtocolRuntime({
      logger,
      shutdownContext: {
        closeId: "fixture-close",
        errorId: "fixture-error",
        origin: "runtime_failure",
        requestedAt: Date.now(),
        deadlineAt: Date.now() + 1200,
        processId: 1,
        transportAvailable: true,
      },
      server: {
        shutdown: async () => {
          throw error;
        },
        disposeProjections() {},
      },
      mcpPort: {
        close: async () => {
          independent = true;
        },
      },
      sessionStore: {
        close: () => {
          storeClosed = true;
        },
      } as unknown as SqliteSessionStore,
    }),
    /fixture failure/,
  );
  assert.equal(independent, true);
  assert.equal(storeClosed, false);
  assert.ok(!JSON.stringify(warnings).includes("fixture-secret"));
  assert.equal(warnings[0]?.errorId, "fixture-error");
  assert.ok(infos.some((info) => info.event === "lcode_protocol.close.summary"));
});

function createDeferred(): {
  promise: Promise<void>;
  reject(error: Error): void;
  resolve(): void;
} {
  let rejectPromise!: (error: Error) => void;
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });
  return { promise, reject: rejectPromise, resolve: resolvePromise };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for cleanup progress");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

function createHarness() {
  const sessionShutdown = createDeferred();
  const order: string[] = [];
  const warnings: Array<{ context?: LogContext; message: string }> = [];
  const infos: LogContext[] = [];
  let shutdownCalls = 0;
  const logger: Logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: (_message, context) => {
      if (context) infos.push(structuredClone(context));
    },
    warn: (message, context) => {
      warnings.push({ context, message });
    },
  };
  const sessionStore = {
    close: () => {
      order.push("store_closed");
    },
  } as unknown as SqliteSessionStore;

  const cleanup = cleanupProtocolRuntime({
    deadlineAt: Date.now(),
    logger,
    mcpConnectionPool: {
      close: async () => {
        order.push("mcp_pool_closed");
      },
    },
    mcpPort: {
      close: async () => {
        order.push("mcp_closed");
      },
    },
    mcpTelemetryTracker: {
      stop: () => {
        order.push("mcp_telemetry_stopped");
      },
    },
    nodeReplBrowserBroker: {
      close: async () => {
        order.push("browser_broker_closed");
      },
    },
    processResourceSampler: {
      stop: () => {
        order.push("sampler_stopped");
      },
    },
    providerRegistryRuntime: {
      dispose: () => {
        order.push("provider_disposed");
      },
    },
    server: {
      disposeProjections: () => {
        order.push("projections_disposed");
      },
      shutdown: () => {
        shutdownCalls += 1;
        order.push("session_shutdown_started");
        return sessionShutdown.promise;
      },
    },
    sessionStore,
  });

  return {
    cleanup,
    order,
    sessionShutdown,
    shutdownCalls: () => shutdownCalls,
    warnings,
    infos,
  };
}

test("protocol cleanup keeps the session store open until timed-out session shutdown settles", async () => {
  const harness = createHarness();
  let cleanupSettled = false;
  void harness.cleanup.finally(() => {
    cleanupSettled = true;
  });

  await waitFor(() => harness.order.includes("provider_disposed"));

  assert.deepEqual(
    [
      "sampler_stopped",
      "mcp_telemetry_stopped",
      "projections_disposed",
      "browser_broker_closed",
      "mcp_closed",
      "mcp_pool_closed",
      "provider_disposed",
    ].filter((event) => !harness.order.includes(event)),
    [],
  );
  assert.equal(harness.order.includes("store_closed"), false);
  assert.equal(cleanupSettled, false);
  assert.equal(harness.shutdownCalls(), 1);
  assert.ok(
    harness.warnings.some(
      ({ context }) => context?.event === "lcode_protocol.sessions.shutdown.pending",
    ),
  );
  assert.equal(
    harness.warnings.some(
      ({ context }) => context?.event === "lcode_protocol.sessions.shutdown.failed",
    ),
    false,
  );

  harness.sessionShutdown.resolve();
  await harness.cleanup;

  assert.ok(harness.order.indexOf("provider_disposed") < harness.order.indexOf("store_closed"));
  assert.equal(harness.shutdownCalls(), 1);
  assert.ok(
    harness.infos.some((info) => info.event === "lcode_protocol.sessions.shutdown.completed"),
  );
  const summary = harness.infos.find((info) => info.event === "lcode_protocol.close.summary");
  assert.ok(JSON.stringify(summary).includes('"resource":"sessions","status":"completed"'));
});

test("protocol cleanup preserves the shared store when session shutdown rejects", async () => {
  const harness = createHarness();

  await waitFor(() => harness.order.includes("provider_disposed"));
  assert.equal(harness.order.includes("store_closed"), false);
  const sessionWarningsBeforeReject = harness.warnings.filter(
    ({ context }) => context?.event === "lcode_protocol.sessions.shutdown.failed",
  ).length;

  harness.sessionShutdown.reject(new Error("durable shutdown failed"));
  await assert.rejects(harness.cleanup, /durable shutdown failed/);

  assert.equal(harness.order.includes("store_closed"), false);
  assert.equal(harness.shutdownCalls(), 1);
  assert.equal(
    harness.warnings.filter(
      ({ context }) => context?.event === "lcode_protocol.sessions.shutdown.failed",
    ).length,
    sessionWarningsBeforeReject + 1,
  );
});

test("noncritical cleanup that rejects after its budget still reports one correlated failure", async () => {
  const deferred = createDeferred();
  const warnings: LogContext[] = [];
  const logger: Logger = {
    child: () => logger,
    debug() {},
    error() {},
    info() {},
    warn: (_message, context) => {
      if (context) warnings.push(context);
    },
  };
  await cleanupProtocolRuntime({
    logger,
    deadlineAt: Date.now(),
    shutdownContext: {
      origin: "runtime_failure",
      processId: 1,
      closeId: "original-close",
      errorId: "original-error",
      requestedAt: Date.now(),
      deadlineAt: Date.now(),
      transportAvailable: false,
    },
    providerRegistryRuntime: { dispose: () => deferred.promise },
  });
  assert.ok(
    warnings.some((item) => item.event === "lcode_protocol.provider_registry.shutdown.pending"),
  );
  deferred.reject(new Error("token=fixture-secret", { cause: new Error("fixture cause") }));
  await new Promise<void>((resolve) => setImmediate(resolve));
  const failed = warnings.filter(
    (item) => item.event === "lcode_protocol.provider_registry.shutdown.failed",
  );
  assert.equal(failed.length, 1);
  assert.equal(failed[0]?.closeId, "original-close");
  assert.equal(failed[0]?.errorId, "original-error");
  assert.ok(!JSON.stringify(failed).includes("fixture-secret"));
});
