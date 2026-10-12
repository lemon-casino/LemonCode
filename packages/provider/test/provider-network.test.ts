import assert from "node:assert/strict";
import test from "node:test";
import { parseProviderConfig } from "../src/index.js";
import { createMembershipFixture, roundtrip } from "./model-membership.fixture.js";

test("provider network survives overlay, membership and serialization", () => {
  const network = {
    mode: "custom" as const,
    httpProxy: "http://127.0.0.1:7891",
    noProxy: ".fixture.invalid",
  };
  const config = parseProviderConfig({ network, api: { headers: { "x-fixture": "value" } } });
  for (const result of [
    config,
    config.withModelOrder(["model"]),
    config.withoutGroup(),
    config.withModelMembershipFrom(undefined),
  ]) {
    assert.deepEqual(result.toJSON().network, network);
  }
  assert.deepEqual(
    config.overlay(parseProviderConfig({ network: { mode: "direct" } })).toJSON().network,
    { mode: "direct" },
  );
  assert.deepEqual(
    config.overlay(parseProviderConfig({ network: { mode: "default" } })).toJSON().network,
    { mode: "default" },
  );
});

test("custom proxy requires a valid HTTP(S) endpoint", () => {
  for (const httpProxy of [undefined, "", "socks4://localhost:7890", "invalid"]) {
    assert.throws(() => parseProviderConfig({ network: { mode: "custom", httpProxy } }));
  }
  assert.throws(() => parseProviderConfig({ network: { mode: "direct", unknown: true } }));
});

test("proxy command preserves API credentials and updates an account-only overlay", async (t) => {
  const fixture = await createMembershipFixture(t);
  const original = fixture.repository.snapshot.providers.get("personal")!.toJSON();
  await fixture.settings.setProviderNetwork("personal", {
    mode: "custom",
    httpProxy: "http://localhost:7891",
  });
  assert.deepEqual(
    fixture.repository.snapshot.providers.get("personal")!.access?.toJSON(),
    original.access,
  );
  await fixture.settings.savePersonalProviderOverlay("personal", original, {
    providerName: "Renamed fixture",
  });
  assert.equal(fixture.repository.snapshot.providers.get("personal")!.network?.mode, "custom");
  fixture.account.providers = fixture.account.providers.set(
    "oauth:fixture",
    parseProviderConfig({
      group: "standard-personal",
      access: { type: "oauth-account", channelId: "fixture" },
      api: { type: "openai-chat-completions", baseUrl: "https://oauth.invalid/v1" },
      builtinModelIds: [],
    }),
  );
  await fixture.registry.refresh("account-added");
  await fixture.settings.setProviderNetwork("oauth:fixture", { mode: "direct" });
  assert.deepEqual(
    roundtrip(fixture.repository.snapshot).providers.get("oauth:fixture")!.toJSON(),
    { network: { mode: "direct" } },
  );
  assert.equal(
    fixture.settings.getView().providers.find((item) => item.providerId === "oauth:fixture")
      ?.effectiveConfig.network?.mode,
    "direct",
  );
  await fixture.settings.deletePersonalProvider("personal");
  await assert.rejects(
    fixture.settings.setProviderNetwork("personal", { mode: "direct" }),
    /不存在/,
  );
});

test("bulk proxy library persists once and provider references track edits without losing credentials", async (t) => {
  const fixture = await createMembershipFixture(t);
  await fixture.settings.importProxyProfiles(
    "http://fixture:password@localhost:7890\nhttps://localhost:8443\nsocks5://fixture:password@localhost:1080\nhttp://fixture:password@localhost:7890",
  );
  const profiles = fixture.settings.getView().proxyProfiles!;
  assert.equal(profiles.length, 3);
  const selected = profiles[0]!;
  await fixture.settings.setProviderNetwork("personal", {
    mode: "profile",
    profileId: selected.id,
  });
  assert.deepEqual(fixture.repository.snapshot.providers.get("personal")!.network, {
    mode: "profile",
    profileId: selected.id,
  });
  const registryProvider = () =>
    fixture.registry
      .getSnapshot()!
      .resolution.registryProviders.find((item) => item.providerId === "personal")!;
  assert.equal(registryProvider().config.network?.mode, "custom");
  await assert.rejects(fixture.settings.deleteProxyProfile(selected.id), /PROXY_PROFILE_IN_USE/);
  await fixture.settings.saveProxyProfile({
    ...selected,
    httpProxy: "socks5://localhost:1081",
    name: "Edited proxy",
  });
  const updated = registryProvider().config.network;
  assert.equal(updated?.mode === "custom" ? updated.httpProxy : "", "socks5://localhost:1081");
  await fixture.settings.reorderPersonalModels("personal", ["Custom"]);
  assert.equal(roundtrip(fixture.repository.snapshot).proxyProfiles!.length, 3);
  await fixture.settings.setProviderNetwork("personal", { mode: "default" });
  await fixture.settings.deleteProxyProfile(selected.id);
  assert.equal(fixture.settings.getView().proxyProfiles!.length, 2);
  await assert.rejects(
    fixture.settings.setProviderNetwork("personal", { mode: "profile", profileId: selected.id }),
    /does not exist/,
  );
});
