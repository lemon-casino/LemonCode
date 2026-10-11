import type { AuthWireProtocol } from "../driver.js";
import { list, record, type Json } from "./common.js";

const COMPOSITIONS = ["allOf", "anyOf", "oneOf"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_VALUES = [
  "items",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "contains",
  "additionalItems",
  "unevaluatedItems",
  "not",
  "if",
  "then",
  "else",
  "contentSchema",
];
const MAX_DEPTH = 32;

function localRef(root: Json, schema: Json): Json {
  if (typeof schema.$ref !== "string" || !schema.$ref.startsWith("#/")) return schema;
  let value: unknown = root;
  for (const segment of schema.$ref.slice(2).split("/")) {
    const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return schema;
    value = record(value)[key];
  }
  const { $ref: _ref, ...siblings } = schema;
  return { ...record(value), ...siblings };
}

/** 仅投影函数参数根；原工具执行校验保持原 Schema，不增加包装参数或改工具名。 */
export function objectToolSchema(root: Json): Json {
  const fold = (value: Json, depth: number): Json => {
    if (depth > MAX_DEPTH) return { type: "object", properties: {} };
    const schema = localRef(root, value);
    if (schema !== value && typeof schema.$ref === "string") return fold(schema, depth + 1);
    if (schema.type === "object" && !COMPOSITIONS.some((key) => Object.hasOwn(schema, key)))
      return schema;
    const props = { ...record(schema.properties) };
    const required = list(schema.required).filter(
      (name): name is string => typeof name === "string",
    );
    for (const branch of list(schema.allOf)) {
      const normalized = fold(record(branch), depth + 1);
      for (const [key, item] of Object.entries(record(normalized.properties)))
        if (!Object.hasOwn(props, key)) props[key] = item;
      required.push(
        ...list(normalized.required).filter((name): name is string => typeof name === "string"),
      );
    }
    const branches = [...list(schema.anyOf), ...list(schema.oneOf)]
      .map((branch) => {
        const resolved = localRef(root, record(branch));
        return COMPOSITIONS.some((key) => Object.hasOwn(resolved, key)) || resolved.$ref
          ? fold(resolved, depth + 1)
          : resolved;
      })
      .filter((branch) => branch.type === "object" || branch.properties);
    const variants = new Map<string, unknown[]>();
    for (const branch of branches) {
      for (const [key, item] of Object.entries(record(branch.properties))) {
        if (Object.hasOwn(props, key)) continue;
        const previous = variants.get(key) ?? [];
        if (!previous.some((existing) => JSON.stringify(existing) === JSON.stringify(item)))
          previous.push(item);
        variants.set(key, previous);
      }
    }
    for (const [key, values] of variants)
      props[key] = values.length === 1 ? values[0] : { anyOf: values };
    if (branches.length)
      required.push(
        ...list(branches[0]!.required).filter(
          (name): name is string =>
            typeof name === "string" &&
            branches.every((branch) => list(branch.required).includes(name)),
        ),
      );
    const out: Json = { ...schema, type: "object", properties: props };
    for (const key of [...COMPOSITIONS, "$ref", "enum", "const", "not"]) delete out[key];
    const names = [...new Set(required)].filter((name) => Object.hasOwn(props, name));
    if (names.length) out.required = names;
    else delete out.required;
    return out;
  };
  return fold(root, 0);
}

/** Cline 的语法编译器不支持 oneOf；只遍历 Schema 位置，不能改参数名或普通 JSON 数据。 */
function oneOfAsAnyOf(schema: Json, depth = 0): Json {
  if (depth > MAX_DEPTH) return schema;
  const out = { ...schema };
  const visit = (value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? oneOfAsAnyOf(record(value), depth + 1)
      : value;
  for (const key of SCHEMA_MAPS)
    if (schema[key] && typeof schema[key] === "object")
      out[key] = Object.fromEntries(
        Object.entries(record(schema[key])).map(([name, item]) => [name, visit(item)]),
      );
  for (const key of SCHEMA_LISTS)
    if (Array.isArray(schema[key])) out[key] = list(schema[key]).map(visit);
  for (const key of SCHEMA_VALUES) {
    const value = schema[key];
    if (Array.isArray(value)) out[key] = value.map(visit);
    else if (value && typeof value === "object") out[key] = visit(value);
  }
  if (Array.isArray(out.oneOf)) {
    const converted = out.oneOf;
    delete out.oneOf;
    if (Array.isArray(out.anyOf)) {
      const existing = out.anyOf;
      delete out.anyOf;
      out.allOf = [...list(out.allOf), { anyOf: existing }, { anyOf: converted }];
    } else out.anyOf = converted;
  }
  return out;
}

export function prepareToolSchemas(
  body: Json,
  protocol: AuthWireProtocol,
  options: { objectRoots?: boolean; oneOfAsAnyOf?: boolean },
): Json {
  if (!Array.isArray(body.tools)) return body;
  const tools = list(body.tools).map((raw) => {
    const tool = record(raw);
    if (protocol === "openai-responses" && tool.type === "namespace")
      return prepareToolSchemas(tool, protocol, options);
    const fn = protocol === "openai-chat-completions" ? record(tool.function) : tool;
    const key = protocol === "anthropic-messages" ? "input_schema" : "parameters";
    if (!fn[key] || typeof fn[key] !== "object") return tool;
    let schema = record(fn[key]);
    if (options.objectRoots) schema = objectToolSchema(schema);
    if (options.oneOfAsAnyOf) schema = oneOfAsAnyOf(schema);
    const normalized = { ...fn, [key]: schema };
    return protocol === "openai-chat-completions" ? { ...tool, function: normalized } : normalized;
  });
  return { ...body, tools };
}
