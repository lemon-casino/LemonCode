import assert from "node:assert/strict";
import test from "node:test";
import { isPluginRefreshRequest } from "./refresh-policy.mjs";

const cases = [
  [
    "factory",
    "https://api.workos.com/user_management/authenticate",
    { grant_type: "refresh_token", refresh_token: "fixture" },
  ],
  [
    "cline",
    "https://api.cline.bot/api/v1/auth/refresh",
    { grantType: "refresh_token", refreshToken: "fixture" },
  ],
  [
    "minimax-code",
    "https://account.minimax.cn/oauth2/token",
    { grant_type: "refresh_token", refresh_token: "fixture" },
  ],
  [
    "minimax-code-global",
    "https://account.minimax.io/oauth2/token",
    { grant_type: "refresh_token", refresh_token: "fixture" },
  ],
  ["qoder", "https://openapi.qoder.sh/api/v1/jobToken/refresh", { refreshToken: "fixture" }],
  [
    "qoder-cn",
    "https://region-openapi.vpc.qoder.com.cn/api/v1/deviceToken/refresh",
    { refreshToken: "fixture" },
  ],
  [
    "trae-cn",
    "https://api.trae.cn/cloudide/api/v3/trae/oauth/ExchangeToken",
    { RefreshToken: "fixture" },
  ],
  [
    "trae-global",
    "https://growsg-normal.trae.ai/cloudide/api/v3/trae/oauth/ExchangeToken",
    { RefreshToken: "fixture" },
  ],
  [
    "workbuddy",
    "https://copilot.tencent.com/v2/plugin/auth/token/refresh",
    { refresh_token: "fixture" },
  ],
  [
    "workbuddy-ai",
    "https://www.workbuddy.ai/v2/plugin/auth/token/refresh",
    { refresh_token: "fixture" },
  ],
  [
    "kiro",
    "https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken",
    { refreshToken: "fixture" },
  ],
  [
    "kiro",
    "https://oidc.us-east-1.amazonaws.com/token",
    { grant_type: "refresh_token", refreshToken: "fixture" },
  ],
];
for (const [channel, url, data] of cases)
  test(`${channel}: only the fixed token purpose can retain completion`, () => {
    const init = {
      method: "POST",
      body: JSON.stringify(data),
      ...(channel.startsWith("workbuddy") ? { headers: { "X-Refresh-Token": "fixture" } } : {}),
    };
    assert.equal(isPluginRefreshRequest(channel, url, init), true);
    for (const invalid of [
      url.replace("https:", "http:"),
      url.replace(new URL(url).hostname, "attacker.example"),
      url + "/inference",
      url.replace("https://", "https://user@"),
    ])
      assert.equal(isPluginRefreshRequest(channel, invalid, init), false);
    assert.equal(isPluginRefreshRequest(channel, url, { ...init, method: "GET" }), false);
    assert.equal(isPluginRefreshRequest(channel, url, { method: "POST", body: "{}" }), false);
    assert.equal(isPluginRefreshRequest("cursor", url, init), false);
  });

test("device exchange, arbitrary IdP and model API never acquire a refresh purpose", () => {
  const init = { method: "POST", body: JSON.stringify({ refreshToken: "fixture" }) };
  for (const [channel, url] of [
    ["trae-cn", "https://api.trae.cn/trae/api/v1/oauth/ExchangeToken"],
    ["kiro", "https://external.example/token"],
    ["cline", "https://api.cline.bot/v1/chat/completions"],
  ])
    assert.equal(isPluginRefreshRequest(channel, url, init), false);
  assert.equal(
    isPluginRefreshRequest("factory", cases[0][1], {
      method: "POST",
      body: JSON.stringify({ grant_type: "password", refresh_token: "fixture" }),
    }),
    false,
  );
});
