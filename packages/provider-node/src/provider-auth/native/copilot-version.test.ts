import assert from "node:assert/strict";
import test from "node:test";
import { CopilotAuthDriver } from "./copilot.js";
import type { AuthGrant } from "../driver.js";

test("Copilot editor model API carries its version while GitHub quota keeps its own headers", async () => {
  const calls: { path: string; version: string | null }[] = [];
  let grant: AuthGrant = {
    type: "oauth",
    access: "fixture-github",
    sessionToken: "fixture-session",
    sessionExpires: Date.now() + 3600000,
  };
  const driver = new CopilotAuthDriver(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({
      path: url.pathname,
      version: new Headers(init?.headers).get("x-github-api-version"),
    });
    return Response.json(
      url.pathname === "/models"
        ? {
            data: [
              {
                id: "fixture",
                model_picker_enabled: true,
                capabilities: { type: "chat" },
                supported_endpoints: ["/chat/completions"],
              },
            ],
          }
        : {},
    );
  });
  const context = {
    read: async () => grant,
    write: async (next: AuthGrant) => {
      grant = next;
    },
  };
  try {
    await driver.models(context);
    await driver.fetch(
      new Request("https://api.githubcopilot.com/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "fixture",
          messages: [{ role: "user", content: "fixture" }],
        }),
      }),
      context,
    );
    await driver.quota(context);
    assert.deepEqual(calls, [
      { path: "/models", version: "2026-01-09" },
      { path: "/chat/completions", version: "2026-01-09" },
      { path: "/copilot_internal/user", version: null },
    ]);
  } finally {
    driver.dispose();
  }
});
