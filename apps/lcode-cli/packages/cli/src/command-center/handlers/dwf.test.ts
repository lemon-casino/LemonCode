import assert from "node:assert/strict";
import test from "node:test";
import { handleDwfCommand } from "./dwf.js";
import type { CommandCenterDeps } from "../types.js";

test("TUI resume explains an unavailable original owner without announcing success", async () => {
  const result = await handleDwfCommand("resume fixture-run", {
    getApp: async () => ({
      resumeWorkflowRun: async () => ({ ok: false, reason: "owner_unavailable" }),
    }),
  } as unknown as CommandCenterDeps);
  assert.match(result.response ?? "", /original conversation.*retry/i);
  assert.doesNotMatch(result.response ?? "", /Resumed dynamic workflow|undefined/);
});
