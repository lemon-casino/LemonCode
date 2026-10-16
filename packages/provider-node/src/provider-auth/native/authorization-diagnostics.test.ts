import assert from "node:assert/strict";
import test from "node:test";
import { AuthAuthorizationTracker } from "../authorization-tracker.js";
import { readAuthorizationDiagnostic } from "../authorization-diagnostics.js";
test("PC-03 native exchange keeps the observed HTTP refusal when a driver raises a generic failure", async () => {
  const tracker = new AuthAuthorizationTracker();
  const request = tracker.fetch(
    async () => new Response("fixture-private-response", { status: 403 }),
  );
  const challenge = await tracker.authorize(async () => ({
    method: "auto",
    complete: async () => {
      await request("https://login.example.test/oauth/token");
      throw new Error("fixture-private-error");
    },
  }));
  await assert.rejects(challenge.complete(), (error) => {
    const diagnostic = readAuthorizationDiagnostic(error, "exchange");
    assert.equal(diagnostic.status, 403);
    assert.equal(diagnostic.code, "rejected");
    assert.equal(diagnostic.phase, "exchange");
    assert.ok(!JSON.stringify(diagnostic).includes("private"));
    return true;
  });
});
