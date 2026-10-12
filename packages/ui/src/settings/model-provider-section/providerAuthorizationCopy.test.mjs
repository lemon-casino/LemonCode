import assert from "node:assert/strict";
import test from "node:test";
import { createAuthDriver } from "../../../../provider-node/src/index.ts";
import { PROVIDER_AUTH_CHANNELS } from "../../../../services/src/model-provider/providerAccountStoreSchema.ts";
import zhCN from "../../i18n/locales/zh-CN.ts";
import enUS from "../../i18n/locales/en-US.ts";
import {
  localizeAuthorizationChannel,
  localizeAuthorizationInstructions,
} from "./providerAuthorizationCopy.ts";

const intl = (messages) => ({
  formatMessage({ id }, values) {
    return (messages[id] ?? id).replace(/\{(\w+)\}/gu, (whole, key) =>
      String(values?.[key] ?? whole),
    );
  },
});
const chinese = /[\u3400-\u9fff]/u;

test("all registered methods have Chinese copy without changing submission contracts", async () => {
  assert.equal(PROVIDER_AUTH_CHANNELS.length, 25);
  for (const source of PROVIDER_AUTH_CHANNELS) {
    const driver = await createAuthDriver(source.id);
    try {
      const channel = { ...source, methods: await driver.methods() };
      const localized = localizeAuthorizationChannel(channel, "zh-CN", intl(zhCN));
      assert.equal(localized.methods.length, channel.methods.length);
      for (const [index, method] of localized.methods.entries()) {
        const original = channel.methods[index];
        assert.match(method.label, chinese, `${source.id}/${method.id}`);
        if (original.description) assert.match(method.description, chinese);
        assert.equal(method.id, original.id);
        assert.equal(method.kind, original.kind);
        assert.equal(method.type, original.type);
        for (const [fieldIndex, field] of (method.fields ?? []).entries()) {
          const raw = original.fields[fieldIndex];
          assert.match(field.label, chinese);
          const { label: _label, placeholder: _placeholder, ...contract } = field;
          const { label: _rawLabel, placeholder: _rawPlaceholder, ...rawContract } = raw;
          assert.deepEqual(contract, rawContract);
        }
      }
      assert.equal(localizeAuthorizationChannel(channel, "en-US", intl(enUS)), channel);
    } finally {
      await driver.dispose?.();
    }
  }
});

test("WorkBuddy descriptions distinguish browser storage from the external client", () => {
  const channel = localizeAuthorizationChannel(
    {
      id: "workbuddy-ai",
      name: "WorkBuddy AI",
      methods: [
        { id: "0", label: "browser", type: "oauth", kind: "browser" },
        { id: "1", label: "local", type: "oauth", kind: "local" },
      ],
    },
    "zh-CN",
    intl(zhCN),
  );
  assert.match(channel.methods[0].description, /无需安装/u);
  assert.match(channel.methods[1].description, /客户端.*保持登录/u);
  assert.match(channel.methods[1].description, /不会读取.*已保存/u);
});

test("device instructions preserve codes and unknown instruction formats", () => {
  const rows = [
    ["copilot", "Enter code: ABCD-1234"],
    ["factory", "Confirm the code ABCD-1234 on Factory's page"],
    ["cline", "Approve the sign-in in the browser — the code is ABCD-1234."],
    [
      "minimax-code",
      "Sign in to MiniMax Code in the browser and confirm the code ABCD-1234; this finishes by itself.",
    ],
    [
      "minimax-code-global",
      "Sign in to MiniMax Code (Global) in the browser and confirm the code ABCD-1234; this finishes by itself.",
    ],
  ];
  for (const [channel, instructions] of rows) {
    const localized = localizeAuthorizationInstructions(
      channel,
      undefined,
      instructions,
      "zh-CN",
      intl(zhCN),
    );
    assert.match(localized, chinese);
    assert.ok(localized.includes("ABCD-1234"));
    assert.equal(
      localizeAuthorizationInstructions(channel, undefined, instructions, "en-US", intl(enUS)),
      instructions,
    );
  }
  assert.equal(
    localizeAuthorizationInstructions(
      "factory",
      undefined,
      "New dynamic step: CODE",
      "zh-CN",
      intl(zhCN),
    ),
    "New dynamic step: CODE",
  );
  const unknown = {
    id: "fixture",
    name: "Fixture",
    methods: [{ id: "custom", label: "Custom", type: "oauth" }],
  };
  assert.equal(localizeAuthorizationChannel(unknown, "zh-CN", intl(zhCN)), unknown);
  const local = {
    id: "1",
    label: "Client",
    kind: "local",
    type: "oauth",
    description: "客户端说明",
  };
  assert.ok(
    localizeAuthorizationInstructions(
      "commandcode-plan",
      local,
      "Uses the account in C:\\fixture\\auth.json.",
      "zh-CN",
      intl(zhCN),
    ).includes("C:\\fixture\\auth.json"),
  );
  assert.equal(
    localizeAuthorizationInstructions(
      "cursor",
      local,
      "New dynamic step: CODE",
      "zh-CN",
      intl(zhCN),
    ),
    "New dynamic step: CODE",
  );
});
