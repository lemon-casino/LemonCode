import assert from "node:assert/strict";
import test from "node:test";
import {
  workflowSettingsChangeSegments,
  workflowSettingsProvenanceRows,
} from "./workflowSettingsChange.js";

test("speed-only workflow revision reports the actual options in the audit record", () => {
  const selection = {
    providerId: "provider",
    modelId: "model",
    options: { reasoningLevel: "high", speed: "fast" },
  };
  const amend = {
    predecessorRunId: "old",
    subagentModel: { from: "provider/model$high", to: "provider/model$high" },
    subagentSelection: {
      from: { ...selection, options: { ...selection.options, speed: "standard" } },
      to: selection,
    },
  };
  const deps = {
    formatMessage: ({ id }: { id: string }, values?: Record<string, string | number>) =>
      id === "chat.toolbar.speed.fast"
        ? "快速"
        : id === "chat.toolbar.speed.standard"
          ? "标准"
          : id === "chat.toolbar.thoughtLevel.value.high"
            ? "高"
            : String(values?.model ?? id),
  };
  assert.match(workflowSettingsChangeSegments(amend, deps)[0]!, /快速/);
  assert.match(workflowSettingsProvenanceRows(amend, deps)[0]!.value, /标准.*→.*快速/);
});
