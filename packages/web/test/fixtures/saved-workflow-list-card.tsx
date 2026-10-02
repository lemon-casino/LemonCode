import { useState } from "react";
import type {
  ToolCallRow,
  ToolCallSavedWorkflowListDisplay,
} from "@lcode/shared/lcode-protocol-v4";
import { ListSavedWorkflowsToolCallBlock } from "@/ToolCallBlocks/renderers/list-saved-workflows.js";
import { buildToolDisplayModel } from "@/lib/toolDisplay.js";
import { toolCallRowToLegacyNode } from "@/v4/toolCallRowAdapter.js";

export function SavedWorkflowListCardFixture() {
  const [scenario, setScenario] = useState("empty");
  const entry = {
    name: "review-template",
    description: "Review the current change",
    scope: "global",
    path: "/fixture/global/workflows/review-template.dwf.ts",
    argNames: ["focus"],
  };
  const display: ToolCallSavedWorkflowListDisplay = {
    kind: "saved_workflow_list",
    workflows: scenario === "success" || scenario === "truncated" ? [entry] : [],
    ...(scenario === "invalid"
      ? { invalid: [{ path: "/fixture/broken.dwf.ts", reason: "Missing description" }] }
      : {}),
    ...(scenario === "truncated" ? { truncated: true } : {}),
  };
  const row: ToolCallRow = {
    kind: "toolCall",
    rowId: 1,
    turnId: "fixture-turn",
    createdAt: 1,
    createdAtSeq: 1,
    toolCallId: `saved-list-fixture-${scenario}`,
    toolName: "ListSavedWorkflows",
    inputText: "{}",
    status: scenario === "error" ? "error" : scenario === "running" ? "running" : "success",
    output: { text: '<saved_workflows count="0"></saved_workflows>', display },
    ...(scenario === "error"
      ? { error: { code: "LIST_FAILED", message: "Saved-template tool request failed" } }
      : {}),
  };
  const node = toolCallRowToLegacyNode(row);
  const displayModel = buildToolDisplayModel(node.toolCall, "/fixture");
  return (
    <section
      aria-label="工具列表卡"
      className="min-w-0 space-y-3 rounded-xl border border-border p-3"
    >
      <h2 className="text-ui-lg font-medium">ListSavedWorkflows</h2>
      <label className="text-ui-sm">
        工具结果{" "}
        <select
          aria-label="工具结果"
          className="rounded-lg border border-border bg-input px-2 py-1"
          value={scenario}
          onChange={(event) => setScenario(event.target.value)}
        >
          {["empty", "success", "invalid", "truncated", "running", "error"].map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>
      <ListSavedWorkflowsToolCallBlock
        toolCallNode={node}
        workspacePath="/fixture"
        displayModel={displayModel}
        viewerSource={displayModel.viewerSource}
        rawFileSummaries={[]}
        isRunning={row.status === "running"}
        statusLabel={row.status === "error" ? "Failed" : "Done"}
        errorText={row.error?.message}
        childToolList={null}
      />
    </section>
  );
}
