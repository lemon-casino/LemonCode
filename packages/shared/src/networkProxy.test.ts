import assert from "node:assert/strict";
import test from "node:test";
import { providerProvisioningPersonalConfigSchema } from "./provider-provisioning.js";
import {
  joinNetworkProxyUrl,
  splitNetworkProxyUrl,
  parseNetworkProxyLines,
} from "./networkProxy.js";

test("proxy credentials roundtrip with special characters without appearing in address", () => {
  for (const protocol of ["http", "https", "socks5"]) {
    const address = `${protocol}://proxy.example:7890`;
    const value = joinNetworkProxyUrl(address, "user@例子", "p:a@ss%/#");
    assert.deepEqual(splitNetworkProxyUrl(value), {
      address,
      username: "user@例子",
      password: "p:a@ss%/#",
    });
    assert.equal(splitNetworkProxyUrl(value).address.includes("ss"), false);
  }
});
test("proxy bulk import deduplicates normalized URLs and reports line numbers", () => {
  assert.deepEqual(
    parseNetworkProxyLines(
      "http://proxy.example:80\nhttp://proxy.example/\n\nsocks5://user:pass@proxy.example:1080\ninvalid",
    ),
    { urls: ["http://proxy.example/", "socks5://user:pass@proxy.example:1080"], invalidLines: [5] },
  );
  assert.throws(() => parseNetworkProxyLines("a".repeat(256 * 1024 + 1)));
});

test("bare percent credentials remain masked and are normalized for bulk authentication", () => {
  const value = "socks5://user:pass%@proxy.example:1080";
  assert.deepEqual(splitNetworkProxyUrl(value), {
    address: "socks5://proxy.example:1080",
    username: "user",
    password: "pass%",
  });
  assert.deepEqual(parseNetworkProxyLines(value).urls, [
    "socks5://user:pass%25@proxy.example:1080",
  ]);
});

test("remote provider provisioning carries proxy definitions with strict validation and old-file compatibility", () => {
  const personal = {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  };
  assert.equal(providerProvisioningPersonalConfigSchema.parse(personal).proxyProfiles, undefined);
  const profiles = [
    { id: "proxy-1", name: "Fixture", httpProxy: "socks5://user:pass@proxy.example:1080" },
  ];
  assert.deepEqual(
    providerProvisioningPersonalConfigSchema.parse({ ...personal, proxyProfiles: profiles })
      .proxyProfiles,
    profiles,
  );
  assert.throws(() =>
    providerProvisioningPersonalConfigSchema.parse({
      ...personal,
      proxyProfiles: [{ ...profiles[0], unknown: true }],
    }),
  );
});
