import assert from "node:assert/strict";
import { createCipheriv, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { methodsFor, authorize, modelList } from "./compatibility.mjs";
import { factoryImports } from "./factory-import.mjs";
import { readZCodeLocal, resolveZCodeLocal, zcodeLocalChallenge } from "./zcode-local.mjs";

test("method fields retain descriptions, defaults, conditions and private input types", async () => {
  let got;
  const hooks = {
    auth: {
      methods: [
        {
          type: "oauth",
          label: "Sign in",
          prompts: [
            {
              key: "mode",
              type: "select",
              message: "Mode",
              default: "team",
              options: [{ value: "team", label: "Team", hint: "Organization" }],
            },
            {
              key: "secret",
              type: "password",
              message: "Secret",
              optional: true,
              placeholder: "Value",
              when: { key: "mode", op: "eq", value: "team" },
            },
            { key: "skip", type: "text", condition: () => false },
          ],
          authorize: async (inputs) => {
            got = inputs;
            return { callback: async () => ({ type: "success", access: "fixture" }) };
          },
        },
      ],
    },
  };
  const method = methodsFor(hooks, "fixture")[0];
  assert.equal(method.fields[0].defaultValue, "team");
  assert.equal(method.fields[0].options[0].hint, "Organization");
  assert.deepEqual(method.fields[1], {
    key: "secret",
    label: "Secret",
    type: "password",
    optional: true,
    placeholder: "Value",
    condition: { key: "mode", value: "team" },
  });
  await authorize(hooks, "fixture", "0", {});
  assert.equal(got.mode, "team");
});

test("model variants are whitelisted and keep model capability facts", () => {
  const [model] = modelList(
    { api: "https://fixture.invalid/v1" },
    {
      test: {
        tool_call: false,
        fast: true,
        variants: {
          high: {
            reasoningEffort: "high",
            secret: "must-not-cross",
            thinking: { type: "enabled", budgetTokens: 4096, token: "hidden" },
          },
          low: { thinkingConfig: { includeThoughts: true, thinkingLevel: "low" } },
        },
      },
    },
  );
  assert.equal(model.toolCall, false);
  assert.deepEqual(model.serviceTiers, ["default", "priority"]);
  assert.deepEqual(model.reasoningEfforts, ["high", "low"]);
  assert.deepEqual(model.reasoningVariants[0], {
    id: "high",
    options: { reasoningEffort: "high", thinking: { type: "enabled", budgetTokens: 4096 } },
  });
  assert.ok(!JSON.stringify(model).includes("hidden"));
});

test("Factory import checks each distinct key, returns safe partial failures and org identity", async () => {
  const calls = [];
  const entries = await factoryImports(
    JSON.stringify([
      { name: "keys.env", content: "FACTORY_API_KEY=fk-first_12345678\nfk-bad_12345678" },
      { name: "more.json", content: '{"key":"fk-first_12345678","other":"fk-second_12345678"}' },
      { name: "wrong.json", content: '{"refresh":"not-a-factory-key"}' },
    ]),
    {
      fetch: async (url, init) => {
        calls.push({ url, init });
        const key = new Headers(init.headers).get("authorization");
        if (key.includes("bad")) return new Response("fk-bad_12345678 secret", { status: 401 });
        return Response.json({
          userId: "same-user",
          orgId: key.includes("first") ? "org-a" : "org-b",
          email: "fixture@example.invalid",
          region: "eu",
        });
      },
    },
  );
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.url === "https://api.factory.ai/api/cli/whoami"));
  const ready = entries.filter((e) => e.status === "ready");
  assert.equal(ready.length, 2);
  assert.notEqual(ready[0].grant.identityKey, ready[1].grant.identityKey);
  assert.equal(ready[0].grant.metadata.region, "eu");
  assert.ok(
    entries.filter((e) => e.status !== "ready").every((e) => !JSON.stringify(e).includes("fk-")),
  );
});

test("Factory import enforces size/count and cancellation before requests", async () => {
  await assert.rejects(
    factoryImports(JSON.stringify([{ name: "big", content: "x".repeat(4 * 1024 * 1024 + 1) }])),
  );
  await assert.rejects(
    factoryImports(
      JSON.stringify([
        {
          name: "many",
          content: Array.from(
            { length: 201 },
            (_, i) => `fk-test_${String(i).padStart(8, "0")}`,
          ).join("\n"),
        },
      ]),
    ),
  );
  let asked = false;
  await assert.rejects(
    factoryImports(JSON.stringify([{ name: "key", content: "fk-first_12345678" }]), {
      signal: AbortSignal.abort(),
      fetch: async () => {
        asked = true;
        return Response.json({});
      },
    }),
  );
  assert.equal(asked, false);
});

function encrypted(text, seed) {
  const key = createHash("sha256").update(seed).digest();
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${data.toString("base64url")}`;
}
test("ZCode local selects independent sites, rereads and falls back without external writes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-local-fixture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  const options = { home, seed: "fixture-secret" };
  const store = {
    "account-provider:coding-plan:account:zai-individual-coding-plan:account:a:api-key": encrypted(
      "zai.fixture",
      options.seed,
    ),
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:b:api-key":
      encrypted("bigmodel.fixture", options.seed),
    "oauth:zai:user_info": encrypted(
      JSON.stringify({ email: "zai@example.invalid" }),
      options.seed,
    ),
    "oauth:bigmodel:user_info": encrypted(
      JSON.stringify({ email: "bigmodel@example.invalid" }),
      options.seed,
    ),
  };
  await writeFile(join(directory, "credentials.json"), JSON.stringify(store));
  const big = await readZCodeLocal("bigmodel", options);
  const zai = await readZCodeLocal("zai", options);
  assert.equal(big.key, "bigmodel.fixture");
  assert.equal(zai.key, "zai.fixture");
  assert.equal(big.user, "bigmodel@example.invalid");
  const grant = {
    type: "oauth",
    access: big.key,
    refresh: JSON.stringify({ ...big, source: "zcode-channel", site: "bigmodel" }),
  };
  store["account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:b:api-key"] =
    encrypted("bigmodel.updated", options.seed);
  await writeFile(join(directory, "credentials.json"), JSON.stringify(store));
  const live = await resolveZCodeLocal("bigmodel", grant, options);
  assert.equal(live.access, "bigmodel.updated");
  assert.equal(JSON.parse(live.refresh).source, "zcode-channel");
  await writeFile(join(directory, "credentials.json"), "{}");
  assert.equal((await resolveZCodeLocal("bigmodel", grant, options)).access, "bigmodel.fixture");
});

test("ZCode team selection stays on its site and rejects switching identity on the old connection", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-team-fixture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  const options = { home, seed: "fixture-secret" };
  const store = {
    "oauth:zai:access_token": encrypted("zai-team-token", options.seed),
    "oauth:bigmodel:access_token": encrypted("bigmodel-team-token", options.seed),
    "account-provider:coding-plan:account:bigmodel-individual-coding-plan:account:b:api-key":
      encrypted("bigmodel.personal", options.seed),
  };
  const settings = {
    providerFamilyDomain: "zai",
    providerFamilyConnectionSelections: {
      zai: { kind: "team-coding-plan", organizationId: "zai-org", projectId: "zai-project" },
      bigmodel: { kind: "team-coding-plan", organizationId: "big-org", projectId: "big-project" },
    },
  };
  await writeFile(join(directory, "credentials.json"), JSON.stringify(store));
  await writeFile(join(directory, "setting.json"), JSON.stringify(settings));
  const own = await readZCodeLocal("bigmodel", options);
  assert.equal(own.org, "big-org");
  assert.equal(own.token, "bigmodel-team-token");
  const grant = { type: "oauth", refresh: JSON.stringify({ ...own, source: "zcode-channel" }) };
  settings.providerFamilyConnectionSelections.bigmodel = { kind: "individual-coding-plan" };
  await writeFile(join(directory, "setting.json"), JSON.stringify(settings));
  await assert.rejects(
    resolveZCodeLocal("bigmodel", grant, options),
    (error) => error.signIn === "expired",
  );
  await writeFile(join(directory, "credentials.json"), "{}");
  await assert.rejects(
    resolveZCodeLocal(
      "bigmodel",
      { type: "oauth", refresh: JSON.stringify({ source: "zcode", site: "zai", key: "zai.key" }) },
      options,
    ),
  );
});

test("model input modality facts survive independently from the image convenience flag", () => {
  const provider = { api: "https://fixture.invalid/v1" };
  const [a, b] = modelList(provider, {
    a: { modalities: { input: ["text", "audio", "pdf", "unknown"] } },
    b: { capabilities: { input: { image: true, video: true, text: false } } },
  });
  assert.deepEqual(a.inputModalities, ["text", "audio", "pdf"]);
  assert.deepEqual(b.inputModalities, ["image", "video"]);
  assert.equal(b.images, true);
});

test("ZCode follows same-identity renewals but expires user, organization and project changes", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-identity-fixture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  const options = { home, seed: "fixture-secret" };
  async function source(user, org, project, token = "renewed-token") {
    await writeFile(
      join(directory, "credentials.json"),
      JSON.stringify({
        "oauth:zai:user_info": encrypted(JSON.stringify({ user_id: user }), options.seed),
        "oauth:zai:access_token": encrypted(token, options.seed),
      }),
    );
    await writeFile(
      join(directory, "setting.json"),
      JSON.stringify({
        providerFamilyConnectionSelections: {
          zai: { kind: "team-coding-plan", organizationId: org, projectId: project },
        },
      }),
    );
  }
  await source("user", "org", "project", "original-token");
  const imported = await zcodeLocalChallenge("zai", options).callback();
  const grant = { ...imported, type: "oauth" };
  await source("user", "org", "project");
  assert.equal(
    JSON.parse((await resolveZCodeLocal("zai", grant, options)).refresh).token,
    "renewed-token",
  );
  for (const [user, org, project] of [
    ["other", "org", "project"],
    ["user", "other", "project"],
    ["user", "org", "other"],
  ]) {
    await source(user, org, project);
    await assert.rejects(
      resolveZCodeLocal("zai", grant, options),
      (error) => error.signIn === "expired",
    );
  }
  await writeFile(join(directory, "credentials.json"), "{}");
  assert.equal(
    JSON.parse((await resolveZCodeLocal("zai", grant, options)).refresh).token,
    "original-token",
  );
});

test("ZCode legacy unknown identity requires the same credential and never adopts a new explicit identity", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "zcode-legacy-fixture-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".zcode", "v2");
  await mkdir(directory, { recursive: true });
  const options = { home, seed: "fixture-secret" };
  const store = {
    "account-provider:coding-plan:account:zai-individual-coding-plan:account:a:api-key": encrypted(
      "same.key",
      options.seed,
    ),
  };
  await writeFile(join(directory, "credentials.json"), JSON.stringify(store));
  const grant = {
    type: "oauth",
    access: "same.key",
    refresh: JSON.stringify({ source: "zcode", site: "zai", key: "same.key" }),
  };
  assert.equal((await resolveZCodeLocal("zai", grant, options)).identityKey, undefined);
  store["oauth:zai:user_info"] = encrypted(
    JSON.stringify({ user_id: "newly-known" }),
    options.seed,
  );
  await writeFile(join(directory, "credentials.json"), JSON.stringify(store));
  assert.equal((await resolveZCodeLocal("zai", grant, options)).identityKey, undefined);
  await assert.rejects(
    resolveZCodeLocal("zai", { ...grant, identityKey: "old-explicit-identity" }, options),
    (error) => error.signIn === "expired",
  );
  await assert.rejects(
    resolveZCodeLocal("zai", { ...grant, accountId: "old-explicit-account" }, options),
    (error) => error.signIn === "expired",
  );
  store["account-provider:coding-plan:account:zai-individual-coding-plan:account:a:api-key"] =
    encrypted("different.key", options.seed);
  await writeFile(join(directory, "credentials.json"), JSON.stringify(store));
  await assert.rejects(
    resolveZCodeLocal("zai", grant, options),
    (error) => error.signIn === "expired",
  );
});
