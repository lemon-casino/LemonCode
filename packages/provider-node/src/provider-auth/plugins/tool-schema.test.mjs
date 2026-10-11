import assert from "node:assert/strict";
import test from "node:test";
import { fetchPluginModel } from "./worker-fetch.mjs";

const union = {
  oneOf: [
    {
      type: "object",
      properties: { a: { type: "string" }, shared: { type: "boolean" } },
      required: ["a", "shared"],
    },
    {
      type: "object",
      properties: { b: { type: "integer" }, shared: { type: "boolean" } },
      required: ["b", "shared"],
    },
  ],
};
async function send(channel, path, payload) {
  let sent;
  await fetchPluginModel({
    channel,
    hooks: {},
    provider: { id: "fixture", api: "https://fixture.invalid/v1" },
    loader: {
      fetch: async (request) => {
        sent = await request.json();
        return Response.json({ ok: true });
      },
    },
    request: {
      url: `https://fixture.invalid/v1/${path}`,
      method: "POST",
      headers: [],
      body: new TextEncoder().encode(JSON.stringify(payload)),
    },
    signal: new AbortController().signal,
  });
  return sent;
}
test("Messages plugin channels project object roots while preserving tools and history", async () => {
  for (const channel of [
    "bigmodel",
    "zai",
    "commandcode-plan",
    "minimax-code",
    "minimax-code-global",
    "kiro",
    "zed",
  ]) {
    const payload = {
      model: "claude-fixture",
      messages: [{ role: "user", content: "fixture" }],
      tools: [{ name: "fixture_tool", input_schema: union }],
    };
    const output = await send(channel, "messages", payload);
    assert.equal(output.tools[0].name, "fixture_tool");
    assert.equal(output.tools[0].input_schema.type, "object");
    assert.deepEqual(output.tools[0].input_schema.required, ["shared"]);
    assert.deepEqual(output.messages, payload.messages);
  }
});
test("Factory's original root union reaches its pinned wrap and unwrap handler", async () => {
  const payload = { tools: [{ name: "fixture_tool", input_schema: union }] };
  assert.deepEqual(await send("factory", "messages", payload), payload);
});

test("Responses plugin models project object roots including namespace tools", async () => {
  const payload = {
    input: [{ role: "user", content: "fixture" }],
    tools: [
      {
        type: "namespace",
        name: "fixture",
        tools: [{ type: "function", name: "fixture_tool", parameters: union }],
      },
    ],
  };
  for (const channel of ["commandcode-plan", "zed", "factory"]) {
    const output = await send(channel, "responses", payload);
    const tool = output.tools[0].tools[0];
    assert.equal(tool.parameters.type, "object");
    assert.equal(tool.name, "fixture_tool");
    assert.deepEqual(tool.parameters.required, ["shared"]);
    assert.deepEqual(output.input, payload.input);
  }
});
test("Cline converts nested oneOf without changing parameter names or data", async () => {
  const payload = {
    messages: [{ role: "user", content: "oneOf ordinary message" }],
    tools: [
      {
        type: "function",
        function: {
          name: "fixture_tool",
          parameters: {
            type: "object",
            properties: {
              oneOf: { type: "string", default: { oneOf: "literal" } },
              mode: { oneOf: [{ const: "a" }, { const: "b" }] },
            },
          },
        },
      },
    ],
  };
  const output = await send("cline", "chat/completions", payload);
  assert.deepEqual(
    output.tools[0].function.parameters.properties.oneOf,
    payload.tools[0].function.parameters.properties.oneOf,
  );
  assert.deepEqual(output.tools[0].function.parameters.properties.mode, {
    anyOf: [{ const: "a" }, { const: "b" }],
  });
  assert.deepEqual(output.messages, payload.messages);
});
test("other Chat channels keep supported JSON Schema unchanged", async () => {
  const payload = {
    tools: [{ type: "function", function: { name: "fixture_tool", parameters: union } }],
  };
  for (const channel of [
    "qoder",
    "qoder-cn",
    "trae-cn",
    "trae-global",
    "workbuddy",
    "workbuddy-ai",
    "mimo-app",
    "cursor",
    "devin",
    "grok",
  ])
    assert.deepEqual(await send(channel, "chat/completions", payload), payload);
});
