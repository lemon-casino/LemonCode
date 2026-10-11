import assert from "node:assert/strict";
import test from "node:test";
import { createCanonicalWslTargetResolver } from "./desktopWslTargetResolver.js";

function fixture() {
  const probes: { finish(): void; disposals: number }[] = [];
  const resolve = createCanonicalWslTargetResolver({
    createBackend: () => {
      let finish!: () => void;
      const ready = new Promise<{ distro: string; user: string }>((done) => {
        finish = () => done({ distro: "TestDistro", user: "tester" });
      });
      const probe = { finish, disposals: 0 };
      probes.push(probe);
      return {
        resolveIdentity: () => ready,
        dispose: () => {
          probe.disposals += 1;
        },
      };
    },
  });
  return { probes, resolve };
}
test("WSL identity: cancelling one consumer keeps a shared probe and a successful cache", async () => {
  const { probes, resolve } = fixture();
  const abort = new AbortController();
  const first = resolve({ kind: "wsl" }, abort.signal);
  const rejected = assert.rejects(first, /取消/);
  const second = resolve({ kind: "wsl" });
  await Promise.resolve();
  abort.abort();
  await rejected;
  assert.equal(probes.length, 1);
  assert.equal(probes[0]!.disposals, 0);
  probes[0]!.finish();
  assert.deepEqual(await second, { kind: "wsl", distro: "TestDistro", user: "tester" });
  await resolve({ kind: "wsl" });
  assert.equal(probes.length, 1);
  assert.equal(probes[0]!.disposals, 1);
});
test("WSL identity: last consumer abort disposes immediately and retires the old cache", async () => {
  const { probes, resolve } = fixture();
  const abort = new AbortController();
  const first = resolve({ kind: "wsl" }, abort.signal);
  const rejected = assert.rejects(first, /取消/);
  await Promise.resolve();
  abort.abort();
  const second = resolve({ kind: "wsl" });
  await rejected;
  assert.equal(probes[0]!.disposals, 1);
  await Promise.resolve();
  assert.equal(probes.length, 2);
  probes[0]!.finish();
  probes[1]!.finish();
  await second;
  await resolve({ kind: "wsl" });
  assert.equal(probes.length, 2);
  assert.ok(probes.every((probe) => probe.disposals === 1));
});
