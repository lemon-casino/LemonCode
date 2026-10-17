import assert from "node:assert/strict";
import test from "node:test";
import type { RemoteTarget } from "@lcode/shared";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

const targets: RemoteTarget[] = [
  { kind: "ssh", host: "example.invalid", username: "tester" },
  { kind: "wsl", distro: "TestDistro", user: "tester" },
  { kind: "docker", container: "test-container" },
];

test("SSH direct, default proxy and distinct saved proxies have separate physical connections", async () => {
  const { registry, attempts } = fixture();
  const target = { kind: "ssh" as const, host: "example.invalid", username: "tester" };
  const direct = registry.connect({ requestId: "direct", target, remoteAssets: {} });
  const proxied = registry.connect({
    requestId: "proxied",
    target: { ...target, useProxy: true },
    remoteAssets: {},
  });
  const sameProxy = registry.connect({
    requestId: "same-proxy",
    target: { ...target, useProxy: true },
    remoteAssets: {},
  });
  const savedProxies = ["first", "second", "first"].map((proxyProfileId, index) =>
    registry.connect({
      requestId: `saved-${index}`,
      target: { ...target, useProxy: true, proxyProfileId },
      remoteAssets: {},
    }),
  );
  assert.equal(attempts.length, 4);
  for (const attempt of attempts) attempt.finish();
  await Promise.all([direct, proxied, sameProxy, ...savedProxies]);
  await registry.dispose();
});
function fixture() {
  let id = 0;
  const attempts: {
    signal: AbortSignal;
    finish: () => void;
    disposals: number;
  }[] = [];
  const registry = createWindowRemoteConnectionRegistry({
    createId: () => `session-${++id}`,
    connect: ({ signal }) =>
      new Promise<{ services: object; dispose(): void }>((resolve) => {
        const attempt = {
          signal,
          disposals: 0,
          finish: () =>
            resolve({
              services: {},
              dispose: () => {
                attempt.disposals += 1;
              },
            }),
        };
        attempts.push(attempt);
      }),
  });
  return { registry, attempts };
}

for (const target of targets) {
  test(`${target.kind}: last waiter cancellation aborts and retry cannot reuse the retired entry`, async () => {
    const { registry, attempts } = fixture();
    const first = registry.connect({ requestId: "first", target, remoteAssets: {} });
    const rejected = assert.rejects(first, /已取消/);
    registry.cancelConnect("first");
    await rejected;
    assert.equal(attempts[0]!.signal.aborted, true);
    const second = registry.connect({ requestId: "second", target, remoteAssets: {} });
    assert.equal(attempts.length, 2);
    attempts[0]!.finish();
    attempts[1]!.finish();
    const session = await second;
    assert.equal(registry.getSession(session.remoteSessionId)?.state, "online");
    assert.equal(attempts[0]!.disposals, 1, "late old handle is disposed exactly once");
    await registry.dispose();
    assert.equal(attempts[1]!.disposals, 1);
  });
}

for (const target of targets.filter((target) => target.kind !== "docker")) {
  test(`${target.kind}: one cancelled waiter preserves the other shared owner`, async () => {
    const { registry, attempts } = fixture();
    const first = registry.connect({ requestId: "first", target, remoteAssets: {} });
    const rejected = assert.rejects(first, /已取消/);
    const second = registry.connect({ requestId: "second", target, remoteAssets: {} });
    registry.cancelConnect("first");
    await rejected;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.signal.aborted, false);
    attempts[0]!.finish();
    await second;
    await registry.dispose();
    assert.equal(attempts[0]!.disposals, 1);
  });
}

test("shutdown disposes a handle that arrives after disposal began", async () => {
  const { registry, attempts } = fixture();
  const connecting = registry.connect({
    requestId: "first",
    target: targets[2]!,
    remoteAssets: {},
  });
  const rejected = assert.rejects(connecting, /已取消/);
  await registry.dispose();
  await rejected;
  attempts[0]!.finish();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(attempts[0]!.disposals, 1);
});
