import assert from "node:assert/strict";
import test from "node:test";
import { getContextBreakdownTone } from "./contextUsagePalette.js";

const SOURCES = [
  "system_tool_schemas",
  "system_prompt",
  "messages",
  "meta_user_context",
  "skills",
  "mcp_tool_schemas",
  "tool_prompt",
] as const;

test("context sources keep distinct stable theme colors", () => {
  const tones = SOURCES.map(getContextBreakdownTone);

  assert.equal(new Set(tones).size, SOURCES.length);
  assert.equal(getContextBreakdownTone("messages"), "var(--color-usage-chart-2)");
  assert.equal(getContextBreakdownTone("system_prompt"), "var(--color-usage-chart-3)");
});
