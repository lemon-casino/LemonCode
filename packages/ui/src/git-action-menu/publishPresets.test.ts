import assert from "node:assert/strict";
import test from "node:test";
import { createPublishOptions } from "./publishModel.js";
import {
  publishPresetStorageKey,
  parsePublishPresets,
  serializePublishPresets,
  applyPublishPreset,
} from "./publishPresets.js";

const preset = {
  name: "Release",
  options: {
    ...createPublishOptions(),
    pushBranch: true,
    remotes: [{ name: "origin", branch: "main" }],
    tagMode: "create-and-push" as const,
    tagStrategy: "patch" as const,
  },
};

test("preset storage isolates workspace identities and falls back to local path", () => {
  assert.notEqual(
    publishPresetStorageKey("/repo", "remote-a"),
    publishPresetStorageKey("/repo", "remote-b"),
  );
  assert.equal(publishPresetStorageKey("/repo", "  "), publishPresetStorageKey("/repo"));
});

test("versioned preset roundtrip preserves only options and rejects unknown or malformed fields", () => {
  const json = serializePublishPresets([preset]);
  assert.deepEqual(parsePublishPresets(json), [preset]);
  for (const value of [
    null,
    "broken",
    JSON.stringify({ version: 2, presets: [preset] }),
    JSON.stringify({ version: 1, presets: [{ ...preset, message: "private draft" }] }),
    JSON.stringify({
      version: 1,
      presets: [{ ...preset, options: { ...preset.options, pushBranch: "yes" } }],
    }),
    JSON.stringify({
      version: 1,
      presets: [{ ...preset, options: { ...preset.options, tagMode: "force" } }],
    }),
  ]) {
    assert.deepEqual(parsePublishPresets(value), []);
  }
});

test("applying a preset derives current semver suggestions without mutating or executing it", () => {
  const options = applyPublishPreset(preset, ["v1.2.3", "v1.10.0"]);
  assert.equal(options.tagName, "v1.10.1");
  options.remotes[0]!.branch = "other";
  assert.equal(preset.options.remotes[0]!.branch, "main");
});
