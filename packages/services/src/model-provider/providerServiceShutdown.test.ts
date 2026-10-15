import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { drainProviderServiceResources } from "./providerServiceShutdown.js";

test("Host preserves independent provider, network and other cleanup failures and waits all owners", async () => {
  const gate = Promise.withResolvers<void>(),
    failures = [new Error("provider"), new Error("network"), new Error("other")];
  const started: string[] = [];
  let closed = false;
  const closing = drainProviderServiceResources(
    {
      runtime: {
        disposeAndWait: async () => {
          started.push("provider");
          throw failures[0];
        },
      },
      hostNetwork: {
        disposeAndWait: async () => {
          started.push("network");
          await gate.promise;
          throw failures[1];
        },
      },
    },
    async () => {
      started.push("other");
      throw failures[2];
    },
  );
  const rejected = assert
    .rejects(closing, (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, failures);
      return true;
    })
    .then(() => {
      closed = true;
    });
  assert.deepEqual(
    started,
    ["provider", "network", "other"],
    "all owners seal admission synchronously",
  );
  await setImmediate();
  assert.deepEqual(started, ["provider", "network", "other"]);
  assert.equal(closed, false);
  gate.resolve();
  await rejected;
});
