import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderAccounts } from "./providerAccounts.js";
for (const phase of ["factory", "authorize"] as const)
  test("PC-03 initial " + phase + " failure returns a retained safe diagnostic", async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "auth-start-diagnostic-"));
    const owner = new ProviderAccounts({
      lockPath: join(dir, "accounts"),
      channels: [{ id: "fixture", name: "Fixture" }],
      credentials: {
        load: async () => null,
        save: async () => assert.fail("must not save"),
        delete: async () => {},
      },
      factory: async () => {
        if (phase === "factory") throw new DOMException("private-code-token", "TimeoutError");
        return {
          methods: async () => [{ id: "login", label: "Login", type: "oauth" as const }],
          authorize: async () => {
            throw new DOMException("private-code-token", "TimeoutError");
          },
          models: async () => [],
          fetch: async () => new Response(),
        };
      },
    });
    t.after(async () => {
      await owner.dispose();
      await rm(dir, { recursive: true, force: true });
    });
    const view = await owner.startAuthorization({ channelId: "fixture", methodId: "login" });
    assert.equal(view.status, "failed");
    assert.equal(view.diagnostic?.code, "timeout");
    assert.equal(view.diagnostic?.phase, "preparing");
    assert.equal(view.diagnostic?.credentialsSaved, false);
    assert.deepEqual(await owner.getAuthorization(view.attemptId), view);
    assert.deepEqual(await owner.cancelAuthorization(view.attemptId), view);
    assert.ok(!JSON.stringify(view).includes("private-code-token"));
  });
