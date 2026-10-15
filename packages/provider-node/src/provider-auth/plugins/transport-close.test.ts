import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { once } from "node:events";
import { PluginWorkerTransport } from "./transport.js";

test(
  "unresponsive owned worker is terminated within remaining budget and reports incomplete cleanup",
  { timeout: 3000 },
  async () => {
    const worker = new Worker("setInterval(() => {}, 1000)", {
      eval: true,
      stdout: true,
      stderr: true,
    });
    await once(worker, "online");
    let exits = 0;
    worker.on("exit", () => {
      exits++;
    });
    const transport = new PluginWorkerTransport(
      "fixture",
      undefined,
      undefined,
      undefined,
      undefined,
      { worker },
    );
    const closing = transport.dispose({ deadlineAt: Date.now() + 25 });
    await assert.rejects(closing, /forced termination/);
    await assert.rejects(transport.dispose(), /forced termination/);
    assert.equal(exits, 1);
  },
);
