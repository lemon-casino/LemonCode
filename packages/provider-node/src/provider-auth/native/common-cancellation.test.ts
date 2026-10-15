import assert from "node:assert/strict";
import test from "node:test";
import { json, requireGrant } from "./common.js";

test("native IO never sends a pre-aborted request and rejects a late credential read", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    json(
      async () => {
        calls++;
        return Response.json({});
      },
      "https://example.test",
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
  const late = new AbortController();
  await assert.rejects(
    requireGrant({
      signal: late.signal,
      read: async () => {
        late.abort();
        return { type: "oauth" };
      },
      write: async () => {},
    }),
    { name: "AbortError" },
  );
});

test("native JSON cannot publish payload whose caller cancels during parsing", async () => {
  const controller = new AbortController();
  await assert.rejects(
    json(
      async () =>
        ({
          ok: true,
          json: async () => {
            controller.abort();
            return { access_token: "late" };
          },
        }) as Response,
      "https://example.test",
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
});
