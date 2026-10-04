import assert from "node:assert/strict";
import { test } from "node:test";
import { integratedTerminalShellSelectionSchema } from "./validationAppSettings.js";

test("settings and Agent protocol shared schema accepts custom terminal shells", () => {
  const selection = {
    mode: "shell",
    dialect: "custom",
    id: "custom:/opt/shell",
    label: "shell",
    path: "/opt/shell",
  };
  assert.deepEqual(integratedTerminalShellSelectionSchema.parse(selection), selection);
  assert.equal(
    integratedTerminalShellSelectionSchema.safeParse({ ...selection, dialect: "unknown" }).success,
    false,
  );
});
