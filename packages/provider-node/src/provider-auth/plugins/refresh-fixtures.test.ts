import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createPluginAuthFixtureDriver } from "../plugins.js";
import type { AuthDriverContext, AuthGrant } from "../driver.js";

const jwt = `fixture.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.fixture`;
const cases: { channel: string; path: string; response: unknown; grant?: Partial<AuthGrant> }[] = [
  {
    channel: "cline",
    path: "/api/v1/auth/refresh",
    response: {
      accessToken: "fixture-next",
      refreshToken: "fixture-rotated",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  },
  {
    channel: "factory",
    path: "/user_management/authenticate",
    response: { access_token: jwt, refresh_token: "fixture-rotated" },
  },
  ...["minimax-code", "minimax-code-global"].map((channel) => ({
    channel,
    path: "/oauth2/token",
    response: { access_token: "fixture-next", refresh_token: "fixture-rotated", expires_in: 3600 },
  })),
  ...["workbuddy", "workbuddy-ai"].map((channel) => ({
    channel,
    path: "/v2/plugin/auth/token/refresh",
    response: {
      code: 0,
      data: { accessToken: "fixture-next", refreshToken: "fixture-rotated", expiresIn: 3600 },
    },
  })),
  ...["qoder", "qoder-cn"].map((channel) => ({
    channel,
    path: "/api/v1/jobToken/refresh",
    response: { token: "fixture-next", refresh_token: "fixture-rotated", expires_in: 3600_000 },
  })),
  ...["qoder", "qoder-cn"].map((channel) => ({
    channel,
    path: "/api/v1/deviceToken/refresh",
    grant: { deviceChat: true },
    response: { token: "fixture-next", refresh_token: "fixture-rotated", expires_in: 3600_000 },
  })),
  ...["trae-cn", "trae-global"].map((channel) => ({
    channel,
    path: "/cloudide/api/v3/trae/oauth/ExchangeToken",
    response: { Result: { Token: jwt, RefreshToken: "fixture-rotated" } },
  })),
  {
    channel: "kiro",
    path: "/refreshToken",
    response: { accessToken: "fixture-next", refreshToken: "fixture-rotated", expiresIn: 3600 },
  },
  {
    channel: "kiro",
    path: "/token",
    grant: { method: "idc", clientId: "fixture-client", clientSecret: "fixture-secret" },
    response: { accessToken: "fixture-next", refreshToken: "fixture-rotated", expiresIn: 3600 },
  },
];

for (const entry of cases)
  test(
    `${entry.channel} ${entry.path}: real worker preserves an admitted rotation after caller cancellation`,
    { timeout: 12_000 },
    async () => {
      const entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>();
      const calls: string[] = [];
      const server = createServer(async (req, res) => {
        for await (const _chunk of req) {
          /* drain fixture request */
        }
        calls.push(req.url!);
        if (req.url === entry.path) {
          entered.resolve();
          await gate.promise;
          res
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify(entry.response));
        } else res.writeHead(400, { "content-type": "application/json" }).end("{}");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const driver = createPluginAuthFixtureDriver(
        entry.channel,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      )!;
      let grant: AuthGrant = {
        type: "oauth",
        access: "fixture-old",
        refresh: "fixture-refresh",
        expires: 1,
        uid: "fixture-user",
        accountId: "fixture-user",
        ...entry.grant,
      };
      const caller = new AbortController(),
        retained: Promise<unknown>[] = [];
      let writes = 0;
      const context: AuthDriverContext = {
        connectionId: "fixture-connection",
        signal: caller.signal,
        read: async () => grant,
        write: async () => {
          assert.fail("cancelled caller used ordinary write");
        },
        captureRefreshCommit: () => {
          const original = grant;
          return async (next) => {
            assert.equal(grant, original);
            writes++;
            grant = next;
          };
        },
        retainRefreshCompletion: (done) => {
          retained.push(done);
          void done.catch(() => {});
        },
      };
      const running = driver.models(context);
      const cancelled = assert.rejects(running, { name: "AbortError" });
      try {
        await Promise.race([
          entered.promise,
          running.then(() => {
            throw new Error("refresh fixture was bypassed");
          }),
        ]);
        const admittedCalls = calls.length;
        assert.equal(retained.length, 1, "Host completion must be retained before the exchange");
        caller.abort();
        await cancelled;
        assert.equal(writes, 0);
        gate.resolve();
        await Promise.all(retained);
        assert.equal(grant.refresh, "fixture-rotated");
        assert.equal(writes, 1);
        await driver.dispose?.();
        assert.equal(
          calls.length,
          admittedCalls,
          "no model/quota/inference RPC after caller cancellation",
        );
      } finally {
        caller.abort();
        gate.resolve();
        await Promise.allSettled([running, cancelled]);
        await driver.dispose?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
