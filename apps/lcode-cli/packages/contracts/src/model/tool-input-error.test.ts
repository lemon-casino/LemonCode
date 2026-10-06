import assert from "node:assert/strict";
import test from "node:test";
import { ModelToolInputErrorSchema } from "./tool-input-error.js";

test("parse-failure diagnostics allow only safe codes and bounded character counts", () => {
  const error = { code: "invalid_json", inputLength: 5974 };
  assert.deepEqual(ModelToolInputErrorSchema.parse(JSON.parse(JSON.stringify(error))), error);
  assert.deepEqual(ModelToolInputErrorSchema.parse({ code: "null_input" }), { code: "null_input" });
  for (const value of [
    { code: "unknown" },
    { code: "invalid_json", inputLength: -1 },
    { code: "invalid_json", inputLength: Infinity },
    { code: "invalid_json", inputLength: 1.5 },
    { code: "invalid_json", rawInput: "private fixture content" },
    null,
  ])
    assert.equal(ModelToolInputErrorSchema.safeParse(value).success, false);
});
