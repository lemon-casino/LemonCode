import { list, number, record, type Json } from "./common.js";

const MAX_SCHEMA_DEPTH = 32;
const SCALAR_FIELDS = [
  "description",
  "nullable",
  "pattern",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
] as const;
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean"]);

/** Google Code Assist 接受 OpenAPI 子集；原 JSON Schema 仍由工具执行入口校验。 */
export function googleToolSchema(root: Json): Json {
  const resolve = (ref: string): Json | undefined => {
    if (!ref.startsWith("#/")) return;
    let node: unknown = root;
    for (const segment of ref.slice(2).split("/")) {
      const key = segment.replaceAll("~1", "/").replaceAll("~0", "~");
      if (!node || typeof node !== "object" || !Object.hasOwn(node, key)) return;
      node = record(node)[key];
    }
    return node && typeof node === "object" && !Array.isArray(node) ? record(node) : undefined;
  };
  const walk = (value: unknown, depth: number, refs: ReadonlySet<string>): Json => {
    if (depth > MAX_SCHEMA_DEPTH) return { type: "object" };
    const schema = record(value);
    if (typeof schema.$ref === "string") {
      const target = resolve(schema.$ref);
      if (!target || refs.has(schema.$ref)) return { type: "object" };
      const { $ref, ...siblings } = schema;
      return walk({ ...target, ...siblings }, depth + 1, new Set([...refs, $ref]));
    }
    if (Array.isArray(schema.allOf)) {
      const { allOf, ...merged } = schema;
      for (const branch of allOf) {
        for (const [key, item] of Object.entries(walk(branch, depth + 1, refs))) {
          if (key === "properties")
            merged.properties = { ...record(merged.properties), ...record(item) };
          else if (key === "required")
            merged.required = [...new Set([...list(merged.required), ...list(item)])];
          else if (merged[key] === undefined) merged[key] = item;
        }
      }
      return walk(merged, depth + 1, refs);
    }
    for (const key of ["anyOf", "oneOf"]) {
      if (!Array.isArray(schema[key])) continue;
      const branches = list(schema[key]).map(record);
      const selected = branches.find((branch) => branch.type !== "null");
      const out = selected ? walk(selected, depth + 1, refs) : { type: "string" };
      if (schema.description !== undefined && out.description === undefined)
        out.description = schema.description;
      if (branches.some((branch) => branch.type === "null")) out.nullable = true;
      out.type ??= "string";
      return out;
    }
    const out: Json = {};
    for (const key of SCALAR_FIELDS) if (schema[key] !== undefined) out[key] = schema[key];
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const type = types.find((item) => typeof item === "string" && TYPES.has(item));
    if (type) out.type = type;
    if (types.includes("null")) out.nullable = true;
    // 只在 Schema 节点过滤关键字；properties 内同名参数是用户数据，必须保留。
    if (schema.properties && typeof schema.properties === "object")
      out.properties = Object.fromEntries(
        Object.entries(record(schema.properties)).map(([key, item]) => [
          key,
          walk(item, depth + 1, refs),
        ]),
      );
    if (schema.items !== undefined) out.items = walk(schema.items, depth + 1, refs);
    if (
      Array.isArray(schema.enum) &&
      schema.enum.length &&
      schema.enum.every((item) => typeof item === "string")
    )
      out.enum = [...schema.enum];
    if (typeof schema.const === "string") out.enum = [schema.const];
    for (const [exclusive, inclusive, bound] of [
      ["exclusiveMinimum", "minimum", Math.max],
      ["exclusiveMaximum", "maximum", Math.min],
    ] as const) {
      const value = number(schema[exclusive]);
      if (value !== undefined) out[inclusive] = bound(number(schema[inclusive]) ?? value, value);
    }
    for (const key of ["required", "propertyOrdering"]) {
      const names = list(schema[key]).filter(
        (name) => typeof name === "string" && Object.hasOwn(record(out.properties), name),
      );
      if (names.length) out[key] = [...new Set(names)];
    }
    out.type ??= out.properties
      ? "object"
      : out.items
        ? "array"
        : out.enum || out.nullable
          ? "string"
          : undefined;
    if (out.type === undefined) delete out.type;
    return out;
  };
  return walk(root, 0, new Set());
}
