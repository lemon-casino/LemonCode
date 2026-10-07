import assert from "node:assert/strict";
import { test } from "node:test";
import { safeEnvironmentError } from "./app/manifest.js";

test("environment diagnostics remove authorization headers, quoted secrets and URL queries", () => {
  const input =
    "Authorization: Bearer private-token\nProxy-Authorization: Basic dXNlcjpwYXNz\npassword='a long secret'\nfetch https://user:password@example.invalid/path?token=query-private&other=opaque#secret\napi_key=private-key";
  const safe = safeEnvironmentError(input);
  for (const secret of [
    "private-token",
    "dXNlcjpwYXNz",
    "a long secret",
    "user:password",
    "query-private",
    "opaque",
    "#secret",
    "private-key",
  ])
    assert.ok(!safe.includes(secret), secret);
  assert.match(safe, /https:\/\/example\.invalid\/path/);
});
test("environment diagnostic redaction precedes bounded tail truncation", () => {
  const value = `${"log ".repeat(4000)}\nAuthorization: Bearer tail-secret`;
  const safe = safeEnvironmentError(new Error(value));
  assert.ok(safe.length <= 8192);
  assert.ok(!safe.includes("tail-secret"));
});
