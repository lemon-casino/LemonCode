import assert from "node:assert/strict";
import test from "node:test";
import { videoInspectToolEntry } from "./video-inspect.js";
import { PermissionService } from "../../permission/service.js";

test("transcript sidecar deny and ask precede an allowed video rule", () => {
  const input = { file_path: "clips/demo.mp4", action: "transcript" };
  const policy = videoInspectToolEntry.resolvePermissionRulePolicy!(input, {
    workingDirectory: process.cwd(),
  })!;
  const service = new PermissionService();
  const capability = {
    ...videoInspectToolEntry.metadata,
    permission: videoInspectToolEntry.permission,
  };
  for (const behavior of ["deny", "ask"] as const) {
    const rules = {
      version: 1 as const,
      allow: [{ toolName: "VideoInspect", ruleContent: "clips/demo.mp4" }],
      [behavior]: [{ toolName: "VideoInspect", ruleContent: "clips/demo.srt" }],
    };
    assert.equal(
      service.checkPermission(
        { toolName: "VideoInspect", input, mode: "build" },
        capability,
        rules,
        policy,
      ).decision,
      behavior,
    );
  }
});
test("transcript allow requires both potential sidecars and permission suggestions name them", () => {
  const policy = videoInspectToolEntry.resolvePermissionRulePolicy!({
    file_path: "clips/含空格 demo.mp4",
    action: "transcript",
  })!;
  assert.equal(
    policy.evaluateRules("allow", [
      { toolName: "VideoInspect", ruleContent: "clips/含空格 demo.mp4" },
    ]),
    false,
  );
  assert.equal(
    policy.evaluateRules("allow", [{ toolName: "VideoInspect", ruleContent: "clips/*" }]),
    true,
  );
  assert.equal(policy.suggestedPermissionUpdates[0]?.rules?.length, 3);
});
test("non-transcript actions do not read or match a sidecar", () => {
  assert.equal(
    videoInspectToolEntry.resolvePermissionRulePolicy!({
      file_path: "clips/demo.mp4",
      action: "frames",
    }),
    undefined,
  );
});

test("relative sidecar rules match equivalent path spellings", () => {
  const policy = videoInspectToolEntry.resolvePermissionRulePolicy!(
    { file_path: "./clips/demo.mp4", action: "transcript" },
    { workingDirectory: process.cwd() },
  )!;
  assert.equal(
    policy.evaluateRules("deny", [{ toolName: "VideoInspect", ruleContent: "clips/demo.srt" }]),
    true,
  );
});
