import { createHash } from "node:crypto";
import type { ToolEntry, ToolHandlerFailure } from "./types.js";

const MAX_SOURCE_FIELDS = 8;
const MAX_SCHEMA_REQUIRED = 24;
const MAX_SCHEMA_NAME_CHARS = 128;

/** 只观察工具定义，绝不传入参数值；用于定位可选来源在模型边界是否变成必填。 */
export function sourceInputDiagnostic(
  entry: ToolEntry,
  issue: NonNullable<ToolHandlerFailure["sourceInputError"]>,
): Record<string, unknown> {
  const properties = entry.inputSchema.properties as Record<string, unknown> | undefined;
  const schemaRequired = Array.isArray(entry.inputSchema.required)
    ? entry.inputSchema.required
        .filter((item): item is string => typeof item === "string")
        .slice(0, MAX_SCHEMA_REQUIRED)
        .map((item) => item.slice(0, MAX_SCHEMA_NAME_CHARS))
        .sort()
    : [];
  const schemaSources = issue.fields
    .slice(0, MAX_SOURCE_FIELDS)
    .sort()
    .map((field) => {
      const value = properties?.[field];
      const schema =
        value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
      const type = typeof schema?.type === "string" ? schema.type : "unspecified";
      return {
        field: field.slice(0, MAX_SCHEMA_NAME_CHARS),
        type: type.slice(0, MAX_SCHEMA_NAME_CHARS),
      };
    });
  const summary = { schemaSources, schemaRequired };
  return {
    sourceReason: issue.reason,
    ...summary,
    // 指纹只覆盖这份有界调查摘要，不参与校验、身份隔离或权限决策。
    schemaFingerprint: createHash("sha256").update(JSON.stringify(summary)).digest("hex"),
  };
}
