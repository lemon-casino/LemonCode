import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAuthDriver } from "./copilot.js";

for (const mode of ["editor", "cli"] as const)
  for (const source of ["caller", "driver"] as const)
    test(`Copilot ${mode}: ${source} cancellation cannot publish a derived session or request models`, async () => {
      const caller = new AbortController(),
        entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>();
      let calls = 0,
        writes = 0;
      const driver = new CopilotAuthDriver(async () => {
        calls++;
        entered.resolve();
        await gate.promise;
        return Response.json({
          token: "fixture-session",
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          endpoints: { api: "https://api.githubcopilot.com" },
        });
      });
      const running = assert.rejects(
        driver.models({
          signal: caller.signal,
          read: async () => ({
            type: "oauth",
            access: "fixture-github",
            ...(mode === "cli" ? { copilotMode: "cli" } : {}),
          }),
          write: async () => {
            writes++;
          },
        }),
        { name: "AbortError" },
      );
      await entered.promise;
      if (source === "caller") caller.abort();
      else driver.dispose();
      gate.resolve();
      await running;
      assert.equal(writes, 0);
      assert.equal(calls, 1);
      driver.dispose();
    });
