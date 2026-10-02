import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderApiKey } from "@lcode/provider";
import { runProviderApiKeyWorker } from "./providerApiKeyImportWorkerClient.js";
import {
  API_KEY_TRANSFER_BATCH_SIZE,
  type ProviderApiKeyWorkerRequest,
  type ProviderApiKeyWorkerResponse,
} from "./providerApiKeyImportWorkerProtocol.js";

class FakeWorker {
  onmessage: ((event: MessageEvent<ProviderApiKeyWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: ProviderApiKeyWorkerRequest[] = [];
  terminated = 0;
  onRun: (() => void) | null = null;
  postMessage(message: ProviderApiKeyWorkerRequest) {
    this.requests.push(message);
    if (message.type === "run") this.onRun?.();
  }
  terminate() {
    this.terminated += 1;
  }
  send(data: ProviderApiKeyWorkerResponse) {
    this.onmessage?.({ data } as MessageEvent<ProviderApiKeyWorkerResponse>);
  }
}

test("100k draft snapshots are sent in bounded chunks and ordered output is admitted only on completion", async () => {
  const fake = new FakeWorker();
  const draft: ProviderApiKey[] = Array.from({ length: 100_001 }, (_, index) => ({
    id: `id-${index}`,
    apiKey: `demo-${index}`,
  }));
  fake.onRun = () => {
    fake.send({ type: "chunk", keys: draft.slice(0, 2) });
    fake.send({ type: "chunk", keys: draft.slice(2, 3) });
    fake.send({ type: "complete", added: 3, duplicates: 0 });
  };
  const result = await runProviderApiKeyWorker(
    draft,
    { kind: "normalize" },
    new AbortController().signal,
    () => fake as unknown as Worker,
  );
  const seeds = fake.requests.filter((request) => request.type === "seed");
  assert.equal(seeds.length, Math.ceil(draft.length / API_KEY_TRANSFER_BATCH_SIZE));
  assert.ok(seeds.every((request) => request.keys.length <= API_KEY_TRANSFER_BATCH_SIZE));
  assert.deepEqual(
    seeds.flatMap((request) => request.keys),
    draft,
  );
  assert.deepEqual(result.keys, draft.slice(0, 3));
  assert.equal(fake.terminated, 1);
});

test("worker errors discard partial chunks and sanitize the failure", async () => {
  const fake = new FakeWorker();
  fake.onRun = () => {
    fake.send({ type: "chunk", keys: [{ id: "partial", apiKey: "demo-partial" }] });
    fake.send({ type: "error", code: "invalidJson" });
  };
  await assert.rejects(
    runProviderApiKeyWorker(
      [],
      { kind: "import", source: "[broken" },
      new AbortController().signal,
      () => fake as unknown as Worker,
    ),
    { message: "invalidJson" },
  );
  assert.equal(fake.terminated, 1);
});

test("abort terminates a pending worker and ignores late completion", async () => {
  const fake = new FakeWorker();
  const abort = new AbortController();
  fake.onRun = () => abort.abort();
  await assert.rejects(
    runProviderApiKeyWorker(
      [],
      { kind: "import", source: "demo-one" },
      abort.signal,
      () => fake as unknown as Worker,
    ),
    { name: "AbortError" },
  );
  fake.send({ type: "complete", added: 1, duplicates: 0 });
  assert.equal(fake.terminated, 1);
});

test("unavailable worker fails without synchronous parsing fallback", async () => {
  await assert.rejects(
    runProviderApiKeyWorker(
      [],
      { kind: "import", source: "demo-one" },
      new AbortController().signal,
      () => {
        throw new Error("worker unavailable");
      },
    ),
    { message: "workerFailed" },
  );
});
