import assert from "node:assert/strict";
import test from "node:test";
import type { AuthDriverContext, AuthGrant } from "../driver.js";
import { createOwnedAuthDriver } from "../owned-driver.js";
import { OpenAIAuthDriver } from "./openai.js";
import { CopilotAuthDriver } from "./copilot.js";
import { CopilotAutoRouter } from "./copilot-auto.js";

for (const singleAttempt of [true, false]) {
  for (const kind of ["openai", "copilot"] as const) {
    test(`${kind}: 401 inference POSTs are ${singleAttempt ? 1 : 2} with ${singleAttempt ? "enhanced" : "legacy"} context`, async () => {
      let posts = 0;
      let refreshes = 0;
      let grant: AuthGrant = {
        type: "oauth",
        access: "fixture",
        refresh: "fixture-refresh",
        expires: Date.now() + 3_600_000,
        sessionToken: "fixture-session",
        sessionExpires: Date.now() + 3_600_000,
      };
      const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path === "/models") return Response.json({ data: [] });
        if (path.endsWith("/token")) {
          refreshes++;
          return Response.json({
            access_token: "next",
            expires_in: 3600,
            token: "next-session",
            expires_at: Date.now() / 1000 + 3600,
          });
        }
        posts++;
        return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
      };
      const driver = await createOwnedAuthDriver(async () =>
        kind === "openai" ? new OpenAIAuthDriver("codex", fetcher) : new CopilotAuthDriver(fetcher),
      );
      const context: AuthDriverContext = {
        ...(singleAttempt ? { routingSingleAttempt: true } : {}),
        read: async () => grant,
        write: async (next) => {
          grant = next;
        },
      };
      try {
        const response = await driver.fetch(
          new Request(
            kind === "openai"
              ? "https://chatgpt.com/backend-api/codex/responses"
              : "https://api.githubcopilot.com/chat/completions",
            {
              method: "POST",
              body: JSON.stringify({ model: "fixture", stream: true, messages: [] }),
            },
          ),
          context,
        );
        await response.text();
        assert.equal(response.status, 401);
        assert.equal(posts, singleAttempt ? 1 : 2);
        assert.equal(refreshes, 1, "auth may refresh without replaying inference");
        assert.equal(driver.routingSingleAttempt, true, "owner wrapper must preserve capability");
      } finally {
        await driver.dispose?.();
      }
    });
  }
  test(`Copilot Auto refusal ${singleAttempt ? "returns before re-selection" : "keeps legacy re-selection"}`, async () => {
    const sent: string[] = [];
    const router = new CopilotAutoRouter(async (input, init) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/auto"))
        return Response.json({
          session_token: "fixture",
          selected_model: { id: "refused" },
        });
      const body = (await request.json()) as { model: string };
      sent.push(body.model);
      return body.model === "refused"
        ? Response.json({ error: { code: "model_not_supported" } }, { status: 400 })
        : Response.json({ choices: [] });
    });
    const response = await router.request(
      { model: "auto", messages: [], stream: false },
      {
        base: "https://api.githubcopilot.com",
        headers: {},
        signal: new AbortController().signal,
        singleAttempt,
        models: [
          {
            id: "available",
            name: "Available",
            protocol: "openai-chat-completions",
            baseURL: "https://api.githubcopilot.com",
          },
        ],
      },
    );
    await response.text();
    assert.deepEqual(sent, singleAttempt ? ["refused"] : ["refused", "available"]);
    assert.equal(response.status, singleAttempt ? 400 : 200);
  });
}
