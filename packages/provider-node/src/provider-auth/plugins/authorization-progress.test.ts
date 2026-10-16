import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginAuthFixtureDriver } from "../plugins.js";
import type { ProviderAuthorizationDiagnostic } from "@lcode/shared";
for (const channel of ["workbuddy", "workbuddy-ai"])
  test(
    "PC-03 " + channel + " reports identity rejection without exposing private response",
    async (t) => {
      const server = createServer((req, res) => {
        req.resume();
        res.setHeader("content-type", "application/json");
        const path = new URL(req.url!, "http://fixture").pathname;
        if (path.endsWith("/auth/state"))
          res.end(
            JSON.stringify({
              code: 0,
              data: { state: "fixture-private-state", authUrl: "https://login.example.test" },
            }),
          );
        else if (path.endsWith("/auth/token"))
          res.end(
            JSON.stringify({
              code: 0,
              data: { accessToken: "fixture-private-token", expiresIn: 3600 },
            }),
          );
        else {
          res.writeHead(403);
          res.end(JSON.stringify({ code: 10002, msg: "fixture-private-response" }));
        }
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const driver = createPluginAuthFixtureDriver(
        channel,
        "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      )!;
      t.after(async () => {
        await driver.dispose?.();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      });
      const progress: ProviderAuthorizationDiagnostic[] = [];
      const challenge = await driver.authorize("0", {}, new AbortController().signal, (fact) =>
        progress.push(fact),
      );
      await assert.rejects(challenge.complete(), (error) => {
        const fact = (error as { diagnostic?: ProviderAuthorizationDiagnostic }).diagnostic;
        assert.equal(fact?.phase, "identity");
        assert.equal(fact?.status, 403);
        assert.equal(fact?.code, "rejected");
        assert.ok(!JSON.stringify(fact).includes("private"));
        return true;
      });
      assert.ok(progress.some((fact) => fact.phase === "exchange"));
      assert.ok(progress.some((fact) => fact.phase === "identity"));
      assert.ok(!JSON.stringify(progress).includes("private"));
    },
  );
