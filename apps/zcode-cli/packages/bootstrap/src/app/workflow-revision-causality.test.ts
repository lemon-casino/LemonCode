import assert from "node:assert/strict";
import test from "node:test";
import type { CausalityGraph } from "@zcode/dynamic-workflow";
import { invalidatedWorkflowSites } from "./workflow-revision-causality.js";

test("revision follows data/control/FIFO dependencies but not incidental sequencing", () => {
  const step = (id: string, source?: string): CausalityGraph["steps"][number] => ({
    id,
    kind: "ask",
    label: id,
    loc: { line: 1, column: 1 },
    lane: "actor#1",
    region: "root",
    certainty: "always",
    ...(source === undefined ? {} : { source }),
  });
  const graph: CausalityGraph = {
    steps: [step("ask#1~actor#1", "ask#1"), step("ask#2"), step("ask#3"), step("ask#4")],
    regions: [],
    lanes: [],
    edges: [
      { from: "ask#1~actor#1", to: "ask#2", kind: "data", certainty: "always" },
      { from: "ask#2", to: "ask#3", kind: "control", certainty: "maybe" },
      { from: "ask#1~actor#1", to: "ask#4", kind: "seq", certainty: "always" },
    ],
  };
  assert.deepEqual(invalidatedWorkflowSites(graph, "ask#1"), ["ask#1", "ask#2", "ask#3"]);
});
