import assert from "node:assert/strict";
import test from "node:test";
import { objectToolSchema, prepareToolSchemas } from "./tool-schema.js";
import { prepareResponses } from "./openai-request.js";
import { autoRequest } from "./copilot-auto-request.js";
import type { AuthWireProtocol } from "../driver.js";
import { list, record } from "./common.js";

const optionalSourceSchema = {
  type: "object",
  required: [],
  properties: {
    code: { type: "string", minLength: 1 },
    path: { type: "string", minLength: 1 },
    timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
  },
  additionalProperties: false,
};

test("optional snippet source fields remain optional in actual request builders", () => {
  const original = structuredClone(optionalSourceSchema);
  for (const channel of ["codex", "chatgpt-api"] as const) {
    const output = prepareResponses(
      {
        input: "fixture",
        tools: [
          { type: "function", name: "EvalWorkflowSnippet", parameters: optionalSourceSchema },
        ],
      },
      channel,
    );
    const tool = record(list(output.tools)[0]);
    assert.deepEqual(record(tool.parameters), optionalSourceSchema);
    assert.equal(tool.strict, undefined);
  }
  for (const protocol of [
    "anthropic-messages",
    "openai-chat-completions",
    "openai-responses",
  ] as const) {
    const output = autoRequest(
      {
        messages: [],
        tools: [
          {
            type: "function",
            function: { name: "EvalWorkflowSnippet", parameters: optionalSourceSchema },
          },
        ],
      },
      "fixture-model",
      protocol,
    );
    const emitted = record(list(output.body.tools)[0]);
    const params =
      protocol === "anthropic-messages"
        ? emitted.input_schema
        : protocol === "openai-chat-completions"
          ? record(emitted.function).parameters
          : emitted.parameters;
    assert.deepEqual(params, optionalSourceSchema);
  }
  assert.deepEqual(optionalSourceSchema, original);
});

const schema = {
  $defs: {
    first: {
      type: "object",
      properties: { mode: { const: "first" }, x: { type: "string" }, common: { type: "boolean" } },
      required: ["mode", "x", "common"],
    },
  },
  oneOf: [
    { $ref: "#/$defs/first" },
    {
      anyOf: [
        {
          type: "object",
          properties: {
            mode: { const: "second" },
            y: { type: "number" },
            common: { type: "boolean" },
          },
          required: ["mode", "y", "common"],
        },
      ],
    },
  ],
  allOf: [{ type: "object", properties: { own: { type: "integer" } }, required: ["own"] }],
};

test("object roots preserve every branch property, common requirements, refs and original definitions", () => {
  const original = structuredClone(schema);
  const output = objectToolSchema(schema);
  assert.equal(output.type, "object");
  assert.deepEqual(Object.keys(record(output.properties)).sort(), [
    "common",
    "mode",
    "own",
    "x",
    "y",
  ]);
  assert.deepEqual(output.required, ["own", "mode", "common"]);
  assert.deepEqual(record(output.properties).mode, {
    anyOf: [{ const: "first" }, { const: "second" }],
  });
  assert.deepEqual(output.$defs, schema.$defs);
  for (const keyword of ["oneOf", "anyOf", "allOf"]) assert.equal(output[keyword], undefined);
  assert.deepEqual(schema, original);
});

test("all tool protocols and Responses namespaces preserve names, history and non-function tools", () => {
  for (const protocol of [
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ] as const) {
    const fn =
      protocol === "anthropic-messages"
        ? { name: "tool", input_schema: schema }
        : { name: "tool", parameters: schema };
    const tool =
      protocol === "openai-chat-completions"
        ? { type: "function", function: fn }
        : { ...fn, type: "function" };
    const body = {
      tools: [tool, { type: "web_search" }],
      messages: [{ role: "tool", content: { oneOf: "ordinary data" } }],
    };
    const output = prepareToolSchemas(body, protocol, { objectRoots: true });
    const normalized =
      protocol === "openai-chat-completions"
        ? record(record((output.tools as object[])[0]).function)
        : record((output.tools as object[])[0]);
    assert.equal(normalized.name, "tool");
    assert.equal(
      record(normalized[protocol === "anthropic-messages" ? "input_schema" : "parameters"]).type,
      "object",
    );
    assert.deepEqual(output.messages, body.messages);
    assert.deepEqual((output.tools as object[])[1], body.tools[1]);
  }
  const output = prepareToolSchemas(
    {
      tools: [
        {
          type: "namespace",
          name: "space",
          tools: [{ type: "function", name: "tool", parameters: schema }],
        },
      ],
    },
    "openai-responses",
    { objectRoots: true },
  );
  const namespace = record(list(output.tools)[0]);
  assert.equal(record(record(list(namespace.tools)[0]).parameters).oneOf, undefined);
});

test("Cline lowers oneOf only at Schema positions and preserves parameter names and data", () => {
  const input = {
    type: "object",
    properties: {
      oneOf: { type: "string", default: { oneOf: "literal" } },
      item: { oneOf: [{ type: "integer" }, { type: "string" }], examples: [{ oneOf: "data" }] },
      blocked: false,
    },
    additionalProperties: false,
  };
  const output = prepareToolSchemas(
    { tools: [{ type: "function", function: { name: "tool", parameters: input } }] },
    "openai-chat-completions",
    { oneOfAsAnyOf: true },
  );
  const lowered = (output.tools as { function: { parameters: typeof input } }[])[0]!.function
    .parameters;
  assert.deepEqual(lowered.properties.oneOf, input.properties.oneOf);
  assert.deepEqual(lowered.properties.item, {
    anyOf: input.properties.item.oneOf,
    examples: input.properties.item.examples,
  });
  assert.equal(lowered.properties.blocked, false);
  assert.equal(lowered.additionalProperties, false);
});

test("Codex, ChatGPT API and Copilot Auto run object projection in their actual request builders", () => {
  for (const channel of ["codex", "chatgpt-api"] as const) {
    const output = prepareResponses(
      { input: "fixture", tools: [{ type: "function", name: "tool", parameters: schema }] },
      channel,
    );
    assert.equal(
      record((output.tools as { parameters: unknown }[])[0]!.parameters).oneOf,
      undefined,
    );
  }
  for (const protocol of [
    "anthropic-messages",
    "openai-responses",
    "openai-chat-completions",
  ] as AuthWireProtocol[]) {
    const output = autoRequest(
      {
        messages: [],
        tools: [{ type: "function", function: { name: "tool", parameters: schema } }],
      },
      "fixture-model",
      protocol,
    );
    const tool = record((output.body.tools as object[])[0]);
    const parameters =
      protocol === "anthropic-messages"
        ? tool.input_schema
        : protocol === "openai-chat-completions"
          ? record(tool.function).parameters
          : tool.parameters;
    assert.equal(record(parameters).type, "object");
    assert.equal(record(parameters).oneOf, undefined);
  }
});
