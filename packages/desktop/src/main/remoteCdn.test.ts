import assert from "node:assert/strict";
import test from "node:test";
import { LCODE_UPDATE_SERVICE_ORIGIN } from "@lcode/shared";
import { resolveRemoteCdnBaseUrls } from "./remoteCdn.js";

test("remote runtime defaults to the same fixed-version download service as desktop updates", () => {
  const previous = process.env.LCODE_CDN_BASE_URL;
  delete process.env.LCODE_CDN_BASE_URL;
  try {
    assert.deepEqual(resolveRemoteCdnBaseUrls({ version: "9.8.7" }), [
      `${LCODE_UPDATE_SERVICE_ORIGIN}/api/v1/releases/download/v9.8.7`,
    ]);
  } finally {
    if (previous !== undefined) process.env.LCODE_CDN_BASE_URL = previous;
  }
});

test("explicit remote base takes precedence and custom CDN retains the legacy layout", () => {
  const previous = process.env.LCODE_CDN_BASE_URL;
  process.env.LCODE_CDN_BASE_URL = "https://fixture.invalid/cdn/";
  try {
    assert.deepEqual(resolveRemoteCdnBaseUrls({ version: "9.8.7" }), [
      "https://fixture.invalid/cdn/lcode/electron/releases/9.8.7",
    ]);
    assert.deepEqual(
      resolveRemoteCdnBaseUrls({
        version: "9.8.7",
        overrideBaseUrl: "https://other.invalid/assets/",
      }),
      ["https://other.invalid/assets"],
    );
  } finally {
    if (previous === undefined) delete process.env.LCODE_CDN_BASE_URL;
    else process.env.LCODE_CDN_BASE_URL = previous;
  }
});
