import assert from "node:assert/strict";
import test from "node:test";
import type { SqliteSessionStore } from "@zcode/adapters/storage";
import type { Logger, LogContext } from "@zcode/contracts";
import { cleanupProtocolRuntime } from "./runtime-cleanup.js";

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
  let shutdownCalls = 0;
  const logger: Logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
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

  harness.sessionShutdown.resolve();
  await harness.cleanup;

  assert.ok(harness.order.indexOf("provider_disposed") < harness.order.indexOf("store_closed"));
  assert.equal(harness.shutdownCalls(), 1);
});

test("protocol cleanup records a rejected session shutdown and still closes the store", async () => {
  const harness = createHarness();

  await waitFor(() => harness.order.includes("provider_disposed"));
  assert.equal(harness.order.includes("store_closed"), false);
  const sessionWarningsBeforeReject = harness.warnings.filter(
    ({ context }) => context?.event === "zcode_protocol.sessions.shutdown.failed",
  ).length;

  harness.sessionShutdown.reject(new Error("durable shutdown failed"));
  await harness.cleanup;

  assert.equal(harness.order.includes("store_closed"), true);
  assert.equal(harness.shutdownCalls(), 1);
  assert.equal(
    harness.warnings.filter(
      ({ context }) => context?.event === "zcode_protocol.sessions.shutdown.failed",
    ).length,
    sessionWarningsBeforeReject + 1,
  );
});
