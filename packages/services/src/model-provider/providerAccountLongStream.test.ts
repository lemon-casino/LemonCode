import assert from "node:assert/strict";
import test from "node:test";
import { ProviderAccountTransport } from "./providerAccountTransport.js";
test(
  "HD-02 long transport ticket survives issuance cleanup and admits feedback without replaying the model",
  { timeout: 10000 },
  async (t) => {
    let now = 0,
      calls = 0,
      feedback = 0;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const transport = new ProviderAccountTransport(
      async () => {
        calls++;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(value) {
              controller = value;
              value.enqueue(new TextEncoder().encode("first"));
            },
          }),
        );
      },
      () => {
        feedback++;
      },
      () => now,
    );
    t.after(() => transport.dispose());
    const invocation = {
      capability: "single-attempt-routing-v1" as const,
      workspaceKey: "w",
      sessionId: "s",
      attemptId: "a",
    };
    const auth = await transport.issue(
      "fixture",
      "model",
      "openai-chat-completions",
      "session",
      invocation,
    );
    const headers = { authorization: "Bearer " + auth.apiKey, "content-type": "application/json" };
    const response = await fetch(auth.baseURL + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "model" }),
    });
    now = 300001;
    await transport.issue("fixture", "model", "openai-chat-completions");
    const result = await fetch(auth.baseURL + "/routing/usage", {
      method: "POST",
      headers,
      body: JSON.stringify({ outcome: "success" }),
    });
    assert.equal(result.status, 204);
    assert.equal(feedback, 1);
    const replay = await fetch(auth.baseURL + "/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "model" }),
    });
    assert.equal(replay.status, 403);
    assert.equal(calls, 1);
    controller!.close();
    assert.equal(await response.text(), "first");
    now += 300001;
    await transport.issue("fixture", "model", "openai-chat-completions");
    assert.equal(
      (await fetch(auth.baseURL + "/routing/usage", { method: "POST", headers, body: "{}" }))
        .status,
      403,
    );
  },
);
