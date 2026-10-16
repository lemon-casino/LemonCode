import { randomUUID as routingUuid } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthDriver, AuthDriverContext } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

const model = {
  id: "fixture",
  name: "Fixture",
  protocol: "openai-chat-completions" as const,
  baseURL: "https://upstream.invalid/v1",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
for (const operation of ["cancel", "dispose"] as const)
  test(`${operation} during credential persistence removes the late committed account`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "oauth-commit-"));
    const saved = new Map<string, string>();
    const started = deferred<void>();
    const release = deferred<void>();
    let first = true;
    const service = new ProviderAccounts({
      lockPath: join(dir, "accounts"),
      channels: [{ id: "fixture", name: "Fixture" }],
      credentials: {
        load: async (key) => saved.get(key) ?? null,
        save: async (key, value) => {
          if (first) {
            first = false;
            started.resolve();
            await release.promise;
          }
          saved.set(key, value);
        },
        delete: async (key) => {
          saved.delete(key);
        },
      },
      factory: async () => ({
        methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
        authorize: async () => ({
          method: "code",
          complete: async () => ({ type: "oauth", access: "token" }),
        }),
        models: async () => [model],
        fetch: async () => new Response("ok"),
      }),
    });
    try {
      const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
      const pending = service.completeAuthorization(attempt.attemptId, "code");
      await started.promise;
      if (operation === "cancel") await service.cancelAuthorization(attempt.attemptId);
      else await service.dispose();
      release.resolve();
      await pending;
      assert.equal((await service.getView()).accounts.length, 0);
      if (operation === "cancel")
        assert.equal((await service.getAuthorization(attempt.attemptId)).status, "cancelled");
    } finally {
      release.resolve();
      await service.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("cold hosts share a serial credential refresh and revoked tickets cannot call removed accounts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-hosts-"));
  const saved = new Map<string, string>();
  const credentials = {
    load: async (key: string) => saved.get(key) ?? null,
    save: async (key: string, value: string) => {
      saved.set(key, value);
    },
    delete: async (key: string) => {
      saved.delete(key);
    },
  };
  let active = 0;
  let maxActive = 0;
  const versions: number[] = [];
  const driver = (): AuthDriver => ({
    routingSingleAttempt: true,
    methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
    authorize: async () => ({
      method: "code",
      complete: async () => ({ type: "oauth", access: "token", revision: 0 }),
    }),
    models: async () => [model],
    fetch: async (_request, context) => {
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        const grant = (await context.read())!;
        versions.push(Number(grant.revision));
        await new Promise<void>((done) => setImmediate(done));
        await context.write({ ...grant, revision: Number(grant.revision) + 1 });
        return new Response("ok");
      } finally {
        active--;
      }
    },
  });
  const options = {
    lockPath: join(dir, "accounts"),
    credentials,
    channels: [{ id: "fixture", name: "Fixture" }],
    factory: async () => driver(),
  };
  const first = new ProviderAccounts(options);
  const second = new ProviderAccounts(options);
  async function invoke(service: ProviderAccounts) {
    const auth = await resolveAuth(service, "fixture", "fixture", undefined, "session");
    return fetch(auth.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}` },
      body: JSON.stringify({ model: "fixture" }),
    });
  }
  try {
    const attempt = await first.startAuthorization({ channelId: "fixture", methodId: "login" });
    await first.completeAuthorization(attempt.attemptId, "code");
    assert.equal((await second.getView()).accounts.length, 1);
    const responses = await Promise.all([invoke(first), invoke(second)]);
    assert.deepEqual(await Promise.all(responses.map((response) => response.text())), ["ok", "ok"]);
    assert.equal(maxActive, 1);
    assert.deepEqual(versions, [0, 1]);
    const auth = await resolveAuth(second, "fixture", "fixture", undefined);
    await first.removeAccount((await first.getView()).accounts[0]!.connectionId);
    const response = await fetch(auth.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${auth.apiKey}` },
      body: JSON.stringify({ model: "fixture" }),
    });
    assert.equal(response.status, 409);
    assert.equal(versions.length, 2);
  } finally {
    await first.dispose();
    await second.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleting an account fences a late model refresh and credential update", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oauth-delete-"));
  const saved = new Map<string, string>();
  const entered = deferred<void>();
  const release = deferred<void>();
  let refresh = false;
  let context: AuthDriverContext | undefined;
  const service = new ProviderAccounts({
    lockPath: join(dir, "accounts"),
    channels: [{ id: "fixture", name: "Fixture" }],
    credentials: {
      load: async (key) => saved.get(key) ?? null,
      save: async (key, value) => {
        saved.set(key, value);
      },
      delete: async (key) => {
        saved.delete(key);
      },
    },
    factory: async () => ({
      methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
      authorize: async () => ({
        method: "code",
        complete: async () => ({ type: "oauth", access: "token" }),
      }),
      models: async (value) => {
        context = value;
        if (refresh) {
          entered.resolve();
          await release.promise;
        }
        return [model];
      },
      fetch: async () => new Response("ok"),
    }),
  });
  try {
    const attempt = await service.startAuthorization({ channelId: "fixture", methodId: "login" });
    const completed = await service.completeAuthorization(attempt.attemptId, "code");
    refresh = true;
    const pending = service.refreshModels(completed.connectionId!);
    await entered.promise;
    await service.removeAccount(completed.connectionId!);
    release.resolve();
    await pending;
    assert.equal((await service.getView()).accounts.length, 0);
    await assert.rejects(context!.write({ type: "oauth", access: "late" }));
  } finally {
    release.resolve();
    await service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

function routingContext() {
  return {
    capability: "single-attempt-routing-v1" as const,
    workspaceKey: "fixture-workspace",
    sessionId: "fixture-session",
    attemptId: routingUuid(),
    turnId: routingUuid(),
    tokens: { total: 8192, quality: "bound" as const },
  };
}
function resolveAuth(
  service: Pick<ProviderAccounts, "resolveRequestAuth">,
  ...args: Parameters<ProviderAccounts["resolveRequestAuth"]>
) {
  return service.resolveRequestAuth(
    args[0],
    args[1],
    args[2],
    args[3] ?? "fixture-session",
    args[4] ?? routingContext(),
  );
}
