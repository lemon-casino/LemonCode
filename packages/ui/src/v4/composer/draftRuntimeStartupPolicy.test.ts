import assert from "node:assert/strict";
import test from "node:test";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { shouldDeferDraftRuntime } from "./draftRuntimeStartupPolicy.js";

test("remote blank drafts defer startup; history and local drafts retain demand behavior", () => {
  for (const target of [
    { kind: "ssh" as const, host: "fixture.invalid", username: "fixture" },
    { kind: "wsl" as const, distro: "Fixture" },
    { kind: "docker" as const, container: "fixture" },
  ]) {
    const identity = buildRemoteWorkspaceIdentity("/fixture", target);
    assert.equal(shouldDeferDraftRuntime(null, identity), true);
    assert.equal(shouldDeferDraftRuntime("history", identity), false);
  }
  assert.equal(shouldDeferDraftRuntime(null), false);
  assert.equal(shouldDeferDraftRuntime(null, "  "), false);
});
