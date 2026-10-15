import assert from "node:assert/strict";
import test from "node:test";
import type { LCodeApp } from "../app/types.js";
import { ProtocolRuntimeResources } from "./runtime-resources.js";
import type { ProtocolShutdownContext } from "@lcode/contracts";

test("App drain receives the original process close context exactly once", async () => {
  const contexts: Array<ProtocolShutdownContext | undefined> = [];
  const context: ProtocolShutdownContext = {
    closeId: "first-close",
    origin: "signal",
    signal: "SIGTERM",
    requestedAt: 1,
    deadlineAt: 2,
    processId: 123,
    transportAvailable: true,
  };
  const resources = new ProtocolRuntimeResources(
    () =>
      ({
        runtime: { beginShutdown() {}, stopActiveForegroundExecution() {} },
        close: async (value?: ProtocolShutdownContext) => {
          contexts.push(value);
        },
      }) as unknown as LCodeApp,
  );
  await resources.create();
  await Promise.all([
    resources.close(context),
    resources.close({ ...context, closeId: "secondary" }),
  ]);
  assert.deepEqual(contexts, [context]);
});

test("shutdown waits for an in-flight App constructor and its late resources", async () => {
  let publish!: (app: LCodeApp) => void;
  let release!: () => void;
  const close = new Promise<void>((resolve) => {
    release = resolve;
  });
  const factory = new Promise<LCodeApp>((resolve) => {
    publish = resolve;
  });
  const owner = new ProtocolRuntimeResources(() => factory);
  const creating = owner.create();
  const rejected = assert.rejects(Promise.resolve(creating), /stopping/);
  let drained = false;
  const shutdown = owner.close().then(() => {
    drained = true;
  });
  await Promise.resolve();
  assert.equal(drained, false);
  publish({
    runtime: { beginShutdown() {}, stopActiveForegroundExecution() {} },
    close: () => close,
  } as unknown as LCodeApp);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  release();
  await Promise.all([rejected, shutdown]);
  assert.equal(drained, true);
});
