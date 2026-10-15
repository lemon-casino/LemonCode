import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthDriver } from "@lcode/provider-node";
import { ProviderAccounts } from "./providerAccounts.js";

test("cross-Host check-in is serialized and safe results and opt-in survive restarting the owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "checkin-hosts-"));
  const saved = new Map<string, string>();
  const owners: ProviderAccounts[] = [];
  let claims = 0;
  const create = () => {
    const owner = new ProviderAccounts({
      lockPath: join(directory, "accounts"),
      channels: [{ id: "workbuddy", name: "WorkBuddy" }],
      credentials: {
        load: async (key) => saved.get(key) ?? null,
        save: async (key, value) => {
          saved.set(key, value);
        },
        delete: async (key) => {
          saved.delete(key);
        },
      },
      factory: async (): Promise<AuthDriver> => ({
        methods: async () => [{ id: "login", label: "Login", type: "oauth" }],
        authorize: async () => ({
          method: "code",
          complete: async () => ({ type: "oauth", access: "fixture-private" }),
        }),
        models: async () => [
          {
            id: "model",
            name: "Friendly model",
            protocol: "openai-responses",
            baseURL: "https://fixture.invalid",
          },
        ],
        checkin: async (context) => {
          const grant = (await context.read())!;
          // 自身令牌刷新会推进代次，签到提交仍须属于同一个授权。
          await context.write({ ...grant, access: "fixture-rotated-private" });
          claims++;
          return { outcome: "claimed", credit: 0, streak: 2 };
        },
        fetch: async () => new Response(),
      }),
    });
    owners.push(owner);
    return owner;
  };
  t.after(async () => {
    await Promise.all(owners.map((o) => o.dispose()));
    await rm(directory, { recursive: true, force: true });
  });
  const a = create(),
    b = create();
  const attempt = await a.startAuthorization({ channelId: "workbuddy", methodId: "login" });
  const authorized = await a.completeAuthorization(attempt.attemptId, "fixture");
  const id = authorized.connectionId!;
  await a.setAutomaticCheckin(id, true);
  await Promise.all([a.checkinAccount(id), b.checkinAccount(id)]);
  assert.equal(claims, 1);
  assert.equal((await b.getView()).accounts[0]!.checkin?.result?.credit, 0);
  assert.equal((await b.getView()).channels[0]?.checkinSupported, true);
  await a.dispose();
  await b.dispose();
  const restarted = create();
  const view = await restarted.getView();
  assert.equal(view.accounts[0]?.checkin?.automatic, true);
  assert.equal(view.accounts[0]?.checkin?.result?.streak, 2);
  assert.doesNotMatch(JSON.stringify(view), /private|rotated|access|generation|baseURL/);
  await restarted.checkinAll();
  assert.equal(claims, 1);
  await restarted.setAccountEnabled(id, false);
  await restarted.setAutomaticCheckin(id, false);
  assert.equal((await restarted.getView()).accounts[0]?.checkin?.automatic, false);
  await restarted.setAutomaticCheckin(id, true);
  await restarted.checkinAll();
  assert.equal(claims, 1);
  await restarted.removeAccount(id);
  assert.equal((await restarted.getView()).accounts.length, 0);
});
