import assert from "node:assert/strict";
import test from "node:test";
import { geminiRequest } from "./google-wire.js";
import { record, list, type Json } from "./common.js";

function parameters(schema: Json): Json {
  const result = geminiRequest({
    model: "gemini-3.6-flash",
    messages: [{ role: "user", content: "fixture" }],
    tools: [{ name: "fixture_tool", input_schema: schema }],
  });
  return record(record(list(record(list(result.tools)[0]).functionDeclarations)[0]).parameters);
}

test("Google tools project nested constraints without removing same-named parameters or mutating input", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      values: {
        type: "object",
        propertyNames: { type: "string", minLength: 1 },
        additionalProperties: { type: "string" },
      },
      count: {
        oneOf: [{ type: "integer", exclusiveMinimum: 0, exclusiveMaximum: 10 }, { type: "null" }],
      },
      propertyNames: { type: "string", description: "parameter name must remain" },
      additionalProperties: { type: "boolean" },
    },
    required: ["count", "propertyNames", "absent"],
    propertyOrdering: ["propertyNames", "absent", "count"],
  };
  const original = structuredClone(schema);
  const output = parameters(schema);
  const props = record(output.properties);
  assert.deepEqual(props.values, { type: "object" });
  assert.deepEqual(props.count, { type: "integer", minimum: 0, maximum: 10, nullable: true });
  assert.deepEqual(props.propertyNames, schema.properties.propertyNames);
  assert.deepEqual(props.additionalProperties, { type: "boolean" });
  assert.deepEqual(output.required, ["count", "propertyNames"]);
  assert.deepEqual(output.propertyOrdering, ["propertyNames", "count"]);
  assert.deepEqual(schema, original);
});

test("Google tools inline references, merge object intersections and normalize nullable arrays", () => {
  const output = parameters({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    $defs: {
      "escaped/name": {
        type: ["string", "null"],
        enum: ["a", "b"],
        default: "a",
        format: "uri",
        title: "drop",
      },
    },
    definitions: {
      count: { type: "integer", minimum: 3, exclusiveMinimum: 1, maximum: 8, exclusiveMaximum: 10 },
    },
    allOf: [
      {
        type: "object",
        properties: {
          name: { $ref: "#/$defs/escaped~1name" },
          count: { $ref: "#/definitions/count" },
        },
        required: ["name"],
      },
      {
        type: "object",
        properties: {
          rows: {
            type: "array",
            items: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  properties: { mode: { const: "read" } },
                  required: ["mode", "missing"],
                },
              ],
            },
          },
        },
        required: ["rows"],
      },
    ],
  });
  const props = record(output.properties);
  assert.deepEqual(props.name, { type: "string", enum: ["a", "b"], nullable: true });
  assert.deepEqual(props.count, { type: "integer", minimum: 3, maximum: 8 });
  assert.deepEqual(props.rows, {
    type: "array",
    items: {
      type: "object",
      nullable: true,
      properties: { mode: { type: "string", enum: ["read"] } },
      required: ["mode"],
    },
  });
  assert.deepEqual(output.required, ["name", "rows"]);
  assert.equal(JSON.stringify(output).includes("$ref"), false);
});

test("Google tools bound cyclic refs and remove unsupported keywords throughout schema nodes", () => {
  const output = parameters({
    type: "object",
    $defs: { self: { type: "object", properties: { next: { $ref: "#/$defs/self" } } } },
    properties: {
      cycle: { $ref: "#/$defs/self" },
      remote: { $ref: "https://example.test/schema" },
      nested: {
        type: "array",
        items: {
          type: "string",
          const: "fixed",
          pattern: "^[a-z]+$",
          minLength: 1,
          maxLength: 20,
          examples: ["x"],
          not: {},
          if: {},
          ...JSON.parse('{"then":{}}'),
          else: {},
          patternProperties: {},
          unevaluatedProperties: false,
        },
      },
      numbers: { type: "integer", enum: [1, 2], multipleOf: 2 },
    },
  });
  const props = record(output.properties);
  assert.ok(JSON.stringify(output).length < 10000);
  assert.deepEqual(props.remote, { type: "object" });
  assert.deepEqual(props.nested, {
    type: "array",
    items: { type: "string", enum: ["fixed"], pattern: "^[a-z]+$", minLength: 1, maxLength: 20 },
  });
  assert.deepEqual(props.numbers, { type: "integer" });
});
