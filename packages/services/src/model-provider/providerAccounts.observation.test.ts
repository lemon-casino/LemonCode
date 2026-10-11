import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthChallenge, AuthDriver } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const driver = (): AuthDriver => ({
  methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
  authorize: async () => ({
    method: "code",
    complete: async () => ({ type: "oauth", access: "fixture" }),
  }),
  models: async () => [
    {
      id: "model",
      name: "Model",
      protocol: "openai-chat-completions",
      baseURL: "https://fixture.invalid/v1",
    },
  ],
  fetch: async () => new Response("ok"),
});

test(
  "another window receives account mutations through atomic credential replacement",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-observation-"));
    const file = join(dir, "credentials.json");
    const saved = new Map<string, string>();
    let writes = 0;
    const options = {
      lockPath: join(dir, "accounts"),
      watchFile: file,
      channels: [{ id: "fixture", name: "Fixture" }],
      factory: async () => driver(),
      credentials: {
        load: async (key: string) => saved.get(key) ?? null,
        save: async (key: string, value: string) => {
          saved.set(key, value);
          const temp = join(dir, `credentials-${++writes}.tmp`);
          await writeFile(temp, JSON.stringify([...saved]));
          await rename(temp, file);
        },
        delete: async (key: string) => {
          saved.delete(key);
        },
      },
    };
    const first = new ProviderAccounts(options);
    const second = new ProviderAccounts(options);
    try {
      await second.getView();
      const changed = deferred<void>();
      const listener = second.onDidChange((view) => {
        if (view.accounts.length === 1 && view.accounts[0]!.models.length === 1) changed.resolve();
      });
      const attempt = await first.startAuthorization({ channelId: "fixture", methodId: "login" });
      const completed = await first.completeAuthorization(attempt.attemptId, "code");
      await changed.promise;
      listener.dispose();
      const disabled = deferred<void>();
      const off = second.onDidChange((view) => {
        if (view.accounts[0]?.enabled === false) disabled.resolve();
      });
      await first.setAccountEnabled(completed.connectionId!, false);
      await disabled.promise;
      off.dispose();
      assert.equal((await second.getView()).accounts[0]!.enabled, false);
    } finally {
      await first.dispose();
      await second.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

test(
  "Host disposal cancels authorization that has not returned a challenge",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-start-"));
    const entered = deferred<void>();
    const release = deferred<AuthChallenge>();
    let cancelled = 0;
    let disposed = 0;
    const service = new ProviderAccounts({
      lockPath: join(dir, "accounts"),
      channels: [{ id: "fixture", name: "Fixture" }],
      credentials: {
        load: async () => null,
        save: async () => {
          throw new Error("must not write");
        },
        delete: async () => {},
      },
      factory: async () => ({
        ...driver(),
        authorize: async () => {
          entered.resolve();
          return release.promise;
        },
        dispose: async () => {
          disposed++;
        },
      }),
    });
    const rejection = assert.rejects(
      service.startAuthorization({ channelId: "fixture", methodId: "login" }),
      /OAUTH_AUTHORIZATION_FAILED/u,
    );
    await entered.promise;
    await service.dispose();
    release.resolve({
      method: "auto",
      complete: async () => ({ type: "oauth", access: "late" }),
      cancel: () => {
        cancelled++;
      },
    });
    await rejection;
    assert.equal(cancelled, 1);
    assert.ok(disposed >= 1);
    await rm(dir, { recursive: true, force: true });
  },
);

test(
  "slow channel discovery cannot return an old account list with a new revision",
  { timeout: 10000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-view-"));
    const saved = new Map<string, string>();
    const entered = deferred<void>();
    const release = deferred<void>();
    const written = deferred<void>();
    let count = 0;
    const service = new ProviderAccounts({
      lockPath: join(dir, "accounts"),
      channels: [{ id: "fixture", name: "Fixture" }],
      credentials: {
        load: async (key) => saved.get(key) ?? null,
        save: async (key, value) => {
          saved.set(key, value);
          written.resolve();
        },
        delete: async () => {},
      },
      factory: async () => {
        const instance = driver();
        if (++count === 1)
          return {
            ...instance,
            methods: async () => {
              entered.resolve();
              await release.promise;
              return instance.methods();
            },
          };
        return instance;
      },
    });
    try {
      const initial = service.getView();
      await entered.promise;
      const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
      const completing = service.completeAuthorization(attempt.attemptId, "code");
      await written.promise;
      release.resolve();
      await completing;
      assert.equal((await initial).accounts.length, 1);
    } finally {
      release.resolve();
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
