import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setImmediate } from "node:timers/promises";
import { ProviderAccounts } from "./providerAccounts.js";
import type { AuthDriver } from "@lcode/provider-node";

test("Host disposal waits for an authorization factory and closes its late driver once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-account-construction-"));
  const entered = Promise.withResolvers<void>(),
    factory = Promise.withResolvers<AuthDriver>();
  let closes = 0,
    closed = false,
    methods = 0;
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials: { load: async () => null, save: async () => {}, delete: async () => {} },
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async () => {
      entered.resolve();
      return factory.promise;
    },
  });
  const authorization = assert.rejects(
    service.startAuthorization({ channelId: "fixture", methodId: "login" }),
  );
  await entered.promise;
  const closing = service.dispose().then(() => {
    closed = true;
  });
  try {
    await setImmediate();
    assert.equal(closed, false);
  } finally {
    factory.resolve({
      methods: async () => {
        methods++;
        return [];
      },
      dispose: async () => {
        closes++;
      },
    } as unknown as AuthDriver);
    await Promise.all([authorization, closing]);
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
  assert.equal(closes, 1);
  assert.equal(methods, 0);
});

test("closing during post-factory credential read fences publication and drains the late driver", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lcode-account-read-close-"));
  const saved = new Map<string, string>(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let blockRead = false,
    lateModels = 0,
    lateCloses = 0,
    closed = false;
  const credentials = {
    load: async (key: string) => {
      if (blockRead) {
        blockRead = false;
        entered.resolve();
        await release.promise;
      }
      return saved.get(key) ?? null;
    },
    save: async (key: string, value: string) => {
      saved.set(key, value);
    },
    delete: async (key: string) => {
      saved.delete(key);
    },
  };
  const driver: AuthDriver = {
    methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
    authorize: async () => ({
      method: "code",
      complete: async () => ({ type: "oauth", access: "fixture" }),
    }),
    models: async () => [],
    fetch: async () => new Response("fixture"),
  };
  const first = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    credentials,
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async () => driver,
  });
  let cold: ProviderAccounts | undefined;
  try {
    const attempt = await first.startAuthorization({ channelId: "fixture", methodId: "login" });
    const completed = await first.completeAuthorization(attempt.attemptId, "code");
    cold = new ProviderAccounts({
      lockPath: join(dir, "accounts"),
      credentials,
      channels: [],
      factory: async () => {
        blockRead = true;
        return {
          ...driver,
          models: async () => {
            lateModels++;
            return [];
          },
          dispose: async () => {
            lateCloses++;
          },
        };
      },
    });
    const refresh = cold.refreshModels(completed.connectionId!).catch(() => {});
    await entered.promise;
    const closing = cold.dispose().then(() => {
      closed = true;
    });
    await setImmediate();
    assert.equal(closed, false);
    release.resolve();
    await Promise.all([refresh, closing]);
    assert.equal(lateModels, 0);
    assert.equal(lateCloses, 1);
  } finally {
    release.resolve();
    await cold?.dispose();
    await first.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});
