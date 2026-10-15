import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ProviderRuntime } from "./providerRuntime.js";
import { createProviderConfigRuntime } from "./providerConfigRuntime.js";

test("runtime closes independent owners, waits account cleanup and retries only its failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-provider-close-"));
  const gate = Promise.withResolvers<void>();
  let accountCloses = 0,
    independent = 0,
    settled = false;
  const runtime = new ProviderRuntime({
    configRuntime: createProviderConfigRuntime({
      personalFilePath: join(dir, "personal.json"),
      lcodeBuiltinFilePath: fileURLToPath(
        new URL("../../../../config/provider/lcode-builtin.json", import.meta.url),
      ),
      watch: false,
      personalPollingIntervalMs: false,
    }),
    disposeAccountSource: async () => {
      accountCloses++;
      await gate.promise;
      if (accountCloses === 1) throw new Error("fixture account close");
    },
    disposeModelSelectionConfiguredDefaultSource: () => {
      independent++;
    },
  });
  const closing = runtime.disposeAndWait();
  assert.equal(runtime.disposeAndWait(), closing);
  const rejected = assert.rejects(closing, AggregateError).then(() => {
    settled = true;
  });
  try {
    await setImmediate();
    assert.equal(independent, 1);
    assert.equal(settled, false);
    assert.throws(() => runtime.start(), /dispose/);
  } finally {
    gate.resolve();
    await rejected;
  }
  await runtime.disposeAndWait();
  await runtime.disposeAndWait();
  assert.equal(accountCloses, 2);
  assert.equal(independent, 1);
  await rm(dir, { recursive: true, force: true });
});
