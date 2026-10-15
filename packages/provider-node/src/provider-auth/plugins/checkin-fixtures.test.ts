import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginAuthFixtureDriver } from "../plugins.js";
import type { AuthGrant } from "../driver.js";

for (const channel of ["workbuddy", "trae-cn", "minimax-code", "minimax-code-global", "qoder-cn"]) {
  test(
    `${channel} bundled check-in uses its account loader and preserves safe reward facts`,
    { timeout: 15_000 },
    async (t) => {
      const calls: string[] = [];
      const server = createServer(async (req, res) => {
        for await (const _ of req) {
          /* drain only fixture bytes */
        }
        const path = new URL(req.url!, "http://fixture.invalid").pathname;
        calls.push(path);
        assert.ok(
          req.headers.authorization || req.headers["x-authorization"] || channel === "workbuddy",
        );
        let body: unknown;
        if (channel === "workbuddy")
          body = {
            code: 0,
            data: path.endsWith("status")
              ? { active: true, today_checked_in: false }
              : { credit: 12, streak_days: 3 },
          };
        else if (channel === "trae-cn")
          body = { code: 0, enable: true, checked_in: path.endsWith("claim"), credits: 12 };
        else if (channel.startsWith("minimax")) {
          assert.match(String(req.headers["x-signature"]), /^[a-f0-9]{32}$/);
          assert.ok(Number(req.headers["x-timestamp"]) > 0);
          body = {
            base_resp: { status_code: 0 },
            data: path.endsWith("status")
              ? { days: [{ is_today: true, status: 2, points: 12, day_no: 3 }] }
              : { claim_result: 1, points: 12, day_no: 3 },
          };
        } else
          body = path.endsWith("claim")
            ? { status: "CLAIMED", benefit: { amount: 12 } }
            : {
                campaigns: [
                  {
                    campaignId: "daily",
                    actionType: "CLAIM_BENEFIT",
                    claimStatus: "CLAIMABLE",
                    benefit: { amount: 12 },
                  },
                ],
              };
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const driver = createPluginAuthFixtureDriver(
        channel,
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      )!;
      t.after(async () => {
        await driver.dispose?.();
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
      });
      let grant: AuthGrant = {
        type: "oauth",
        access: "fixture-access",
        refresh: "fixture-refresh",
        uid: "fixture-user",
        accountId: "fixture-user",
        deviceToken: "fixture-device",
        deviceRefresh: "fixture-device-refresh",
        expires: Date.now() + 3600_000,
      };
      const result = await driver.checkin!({
        read: async () => grant,
        write: async (next) => {
          grant = next;
        },
      });
      assert.equal(result.outcome, "claimed");
      assert.equal(result.credit, 12);
      assert.equal(calls.length, 2);
      assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|fixture-device/);
    },
  );
}
