import assert from "node:assert/strict";
import test from "node:test";
import {
  EvalWorkflowSnippetInputJsonSchema,
  EvalWorkflowSnippetInputSchema,
} from "@lcode/contracts";
import { toAiSdkTools } from "./tool-transform.js";

for (const providerKind of ["openai", "anthropic", "openai-compatible", "custom"] as const) {
  for (const requiresMfjsToolSchema of [false, true]) {
    test(`${providerKind} snippet schema preserves omission (ref projection=${requiresMfjsToolSchema})`, async () => {
      const original = structuredClone(EvalWorkflowSnippetInputJsonSchema);
      const tools = toAiSdkTools(
        [{ name: "EvalWorkflowSnippet", inputSchema: EvalWorkflowSnippetInputJsonSchema }],
        { providerKind, modelId: "claude-fixture", requiresMfjsToolSchema },
      );
      const tool = tools!.EvalWorkflowSnippet!;
      assert.ok(
        "jsonSchema" in tool.inputSchema,
        "the transform must produce an eager JSON schema",
      );
      const schema = await tool.inputSchema.jsonSchema;
      assert.deepEqual(schema.required, []);
      assert.equal(schema.additionalProperties, false);
      assert.equal(tool.strict, undefined);
      assert.deepEqual(Object.keys(schema.properties as object), ["code", "path", "timeoutMs"]);
      assert.deepEqual(EvalWorkflowSnippetInputJsonSchema, original);
      assert.equal(EvalWorkflowSnippetInputSchema.safeParse({ code: "return 1;" }).success, true);
      assert.equal(EvalWorkflowSnippetInputSchema.safeParse({ path: "snippet.ts" }).success, true);
    });
  }
}
