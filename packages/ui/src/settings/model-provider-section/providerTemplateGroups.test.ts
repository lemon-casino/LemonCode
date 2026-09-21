import assert from "node:assert/strict";
import test from "node:test";
import { groupProviderTemplates } from "./providerTemplateGroups.js";

test("known providers stay in their brand groups", () => {
  const groups = groupProviderTemplates([
    { templateId: "openai" },
    { templateId: "moonshot-kimi" },
    { templateId: "unknown-lab" },
  ] as never);
  assert.deepEqual(
    groups.map((group) => group.id),
    ["kimi", "openai", "other"],
  );
  assert.deepEqual(
    groups.at(-1)?.templates.map((template) => template.templateId),
    ["unknown-lab"],
  );
});
