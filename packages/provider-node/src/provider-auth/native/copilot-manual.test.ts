import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAuthDriver } from "./copilot.js";
import type { AuthGrant } from "../driver.js";

const cases = [
  ["claude-opus-4.8", "/v1/messages"],
  ["claude-fable-5.1", "/v1/messages"],
  ["gemini-3.7-flash", "/chat/completions"],
  ["gemini-4-argon", "/chat/completions"],
  ["gpt-6.1-sol", "/responses"],
] as const;
for (const [model, path] of cases)
  test(`${model} cold account honors catalog endpoint and activates policy without replacing identity`, async () => {
    const calls: Request[] = [];
    let enabled = false;
    let grant: AuthGrant = {
      type: "oauth",
      access: "fixture",
      sessionToken: "session",
      sessionExpires: Date.now() + 3600_000,
    };
    const driver = new CopilotAuthDriver(async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/models")
        return Response.json({
          data: [
            {
              id: model,
              model_picker_enabled: true,
              supported_endpoints: [path],
              policy: { state: "disabled", terms: "Enable" },
              capabilities: { type: "chat" },
            },
          ],
        });
      if (url.pathname.endsWith("/policy")) {
        enabled = true;
        return new Response(null, { status: 204 });
      }
      assert.equal(url.pathname, path);
      assert.equal(enabled, true);
      assert.equal(request.headers.get("x-github-api-version"), "2026-01-09");
      assert.equal(((await request.json()) as { model: string }).model, model);
      return Response.json({ id: "ok" });
    });
    const context = {
      read: async () => grant,
      write: async (value: AuthGrant) => {
        grant = value;
      },
    };
    try {
      const response = await driver.fetch(
        new Request(`https://api.githubcopilot.com${path}`, {
          method: "POST",
          body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
        }),
        context,
      );
      assert.equal(response.status, 200);
      assert.equal(calls.filter((r) => new URL(r.url).pathname === path).length, 1);
    } finally {
      driver.dispose();
    }
  });

test("an account refusal preserves model identity, records the refusal and explains its scope", async () => {
  let offline = false;
  let grant: AuthGrant = {
    type: "oauth",
    access: "fixture",
    sessionToken: "session",
    sessionExpires: Date.now() + 3600_000,
  };
  const driver = new CopilotAuthDriver(async (input) => {
    if (offline) throw new Error("fixture catalog offline");
    return new URL(String(input)).pathname === "/models"
      ? Response.json({
          data: [
            { id: "claude-opus-4.8", model_picker_enabled: true, capabilities: { type: "chat" } },
          ],
        })
      : Response.json(
          {
            error: {
              code: "model_not_supported",
              message: "The requested model is not supported.",
            },
          },
          { status: 400 },
        );
  });
  const context = {
    read: async () => grant,
    write: async (v: AuthGrant) => {
      grant = v;
    },
  };
  try {
    const response = await driver.fetch(
      new Request("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "claude-opus-4.8", messages: [] }),
      }),
      context,
    );
    assert.equal(response.headers.get("x-zcode-model-refused"), "true");
    assert.match(
      ((await response.json()) as { error: { message: string } }).error.message,
      /this account cannot currently call it/,
    );
    assert.equal(
      (await driver.models(context)).some((m) => m.id === "claude-opus-4.8"),
      false,
    );
    offline = true;
    await assert.rejects(driver.modelCatalog(context), /offline/);
    offline = false;
    assert.equal(
      (await driver.models(context)).some((m) => m.id === "claude-opus-4.8"),
      false,
    );
    assert.equal(
      (await driver.modelCatalog(context)).models.some((m) => m.id === "claude-opus-4.8"),
      true,
    );
  } finally {
    driver.dispose();
  }
});
