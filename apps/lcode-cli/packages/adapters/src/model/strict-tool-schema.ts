// ============================================================
// Anthropic strict 工具 schema：资格判定 + 子集折叠
// ============================================================
// Anthropic `strict: true` 用 constrained decoding 保证 tool_use.input 恰好满足 input_schema，
// 但只接受 JSON Schema 的一个子集（API 文档「JSON Schema Limitations」）：
//   支持：object/array/string/integer/number/boolean/null、enum/const/anyOf/allOf、
//         一组 string format、`additionalProperties: false`（所有 object 必填）。
//   不支持：数值约束（minimum/maximum/multipleOf）、字符串长度约束、复杂数组约束、递归 $ref、
//         `additionalProperties` 取 false 以外的值。
// 本模块把一份普通 schema 变成严格子集里的等价物：能折的约束**折进 description**（模型仍读得到，
// 引擎侧校验器仍强制），折不了的形状返回 undefined（调用方原样发送、不带 strict）。
// 首个使用者是 dwf mono 子代理的 typed `submit_result`。

import type { JsonSchema } from "@lcode/contracts";

/** strict 模式认识的 string format；其余 format 折进 description。 */
const STRICT_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** 折进 description 的关键字及其措辞。 */
const FOLDED_KEYWORDS: Record<string, (value: unknown) => string> = {
  minimum: (v) => `minimum ${String(v)}`,
  maximum: (v) => `maximum ${String(v)}`,
  exclusiveMinimum: (v) => `greater than ${String(v)}`,
  exclusiveMaximum: (v) => `less than ${String(v)}`,
  multipleOf: (v) => `multiple of ${String(v)}`,
  minLength: (v) => `at least ${String(v)} characters`,
  maxLength: (v) => `at most ${String(v)} characters`,
  pattern: (v) => `must match /${String(v)}/`,
  minItems: (v) => `at least ${String(v)} items`,
  maxItems: (v) => `at most ${String(v)} items`,
  default: (v) => `default ${JSON.stringify(v)}`,
};

/**
 * 判断 modelId 是否为 Anthropic 首方直连模型（裸 `claude-` 前缀；`anthropic/claude-…` 等
 * 网关路由 ID 不算）。只有首方模型走 strict。兼容网关可能拒绝不认识的工具字段，因此
 * 资格判定和 provider 能力边界必须保持分开；无法确认资格时沿用普通 schema 行为。
 */
export function isAnthropicFirstPartyModelId(modelId: string | undefined): boolean {
  return typeof modelId === "string" && modelId.startsWith("claude-");
}

/**
 * 把 schema 转成 strict 子集里的等价物；形状不可表达时返回 undefined。
 *
 * 不可表达 = `$ref`/`$defs`（递归）、`additionalProperties` 是 schema（Record<string, T>）、
 * 空 schema `{}`（`unknown`，无 type 可约束）、tuple（`prefixItems`）。可折叠 = FOLDED_KEYWORDS
 * 与 strict 之外的 `format`。object 缺省补 `additionalProperties: false`（合成侧本就发射它）。
 */
export function toStrictToolSchema(schema: JsonSchema): JsonSchema | undefined {
  const out = strictNode(schema);
  return out === INELIGIBLE ? undefined : out;
}

const INELIGIBLE = Symbol("ineligible");
type StrictNode = JsonSchema | typeof INELIGIBLE;

function strictNode(node: JsonSchema): StrictNode {
  if ("$ref" in node || "$defs" in node || "prefixItems" in node) return INELIGIBLE;

  const notes: string[] = [];
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(node)) {
    const fold = FOLDED_KEYWORDS[key];
    if (fold !== undefined) {
      notes.push(fold(value));
      continue;
    }
    if (key === "format" && typeof value === "string" && !STRICT_STRING_FORMATS.has(value)) {
      notes.push(`format ${value}`);
      continue;
    }
    out[key] = value;
  }

  // 递归：properties / items / anyOf / allOf / additionalProperties。
  if (isRecord(out.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [name, child] of Object.entries(out.properties)) {
      if (!isRecord(child)) return INELIGIBLE;
      const strictChild = strictNode(child);
      if (strictChild === INELIGIBLE) return INELIGIBLE;
      properties[name] = strictChild;
    }
    out.properties = properties;
  }
  if (isRecord(out.items)) {
    const items = strictNode(out.items);
    if (items === INELIGIBLE) return INELIGIBLE;
    out.items = items;
  }
  for (const combinator of ["anyOf", "allOf"] as const) {
    const branches = out[combinator];
    if (!Array.isArray(branches)) continue;
    const strictBranches: JsonSchema[] = [];
    for (const branch of branches) {
      if (!isRecord(branch)) return INELIGIBLE;
      const strictBranch = strictNode(branch);
      if (strictBranch === INELIGIBLE) return INELIGIBLE;
      strictBranches.push(strictBranch);
    }
    out[combinator] = strictBranches;
  }

  const types = Array.isArray(out.type) ? out.type : out.type === undefined ? [] : [out.type];
  if (types.includes("object")) {
    // Record<string, T>：additionalProperties 是 schema → 严格子集表达不了。
    if (isRecord(out.additionalProperties)) return INELIGIBLE;
    if (out.additionalProperties !== false) out.additionalProperties = false;
    if (!isRecord(out.properties)) out.properties = {};
  }
  // 空 schema（unknown）：没有任何可约束的东西，strict 不接受。
  if (Object.keys(out).length === 0 && notes.length === 0) return INELIGIBLE;

  if (notes.length > 0) {
    const existing = typeof out.description === "string" ? out.description.trim() : "";
    const folded = notes.join("; ");
    out.description = existing.length > 0 ? `${existing} (${folded})` : folded;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
