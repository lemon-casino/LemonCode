import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@lcode/services";
import { initializeNewTaskDraft, refreshUneditedNewTaskDefaults } from "./newTaskDraft.js";
import { applyComposerPermissionGrant } from "./composerPermissionGrant.js";
import { captureComposerRecentSubmission } from "../../lib/composerRecent.js";

const selection = {
  providerId: "oauth-provider",
  modelId: "model",
  options: { reasoningLevel: "low", speed: "standard" },
};
const view = {
  revision: 1,
  providers: [
    {
      providerId: "oauth-provider",
      models: [
        {
          modelId: "model",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["low", "high"] },
              speed: { values: ["standard", "fast"] },
            },
          },
        },
      ],
    },
  ],
} as unknown as ModelSelectionView;
const defaults = { modelSelection: selection, approvalMode: "edit" as const };

test("explicit defaults retain chosen reasoning and speed instead of highest defaults", () => {
  const draft = initializeNewTaskDraft(
    { text: "", updatedAt: 0 },
    "/repo",
    undefined,
    view,
    defaults,
  );
  assert.deepEqual(draft.modelSelection, selection);
  assert.equal(draft.mode, "edit");
  assert.equal(draft.planEnabled, false);
});

test("defaults refresh an unedited empty draft but preserve manual configuration and text", () => {
  const draft = { text: "", updatedAt: 0, mode: "build" as const };
  const next = refreshUneditedNewTaskDefaults(draft, view, defaults);
  assert.deepEqual(next.modelSelection, selection);
  assert.equal(next.mode, "edit");
  assert.equal(refreshUneditedNewTaskDefaults(next, view, defaults), next);
  const edited = { ...draft, modelSelectionEdited: true as const };
  assert.equal(refreshUneditedNewTaskDefaults(edited, view, defaults), edited);
  const modeEdited = { ...draft, approvalModeEdited: true as const };
  assert.equal(refreshUneditedNewTaskDefaults(modeEdited, view, defaults).mode, "build");
  const withText = { ...draft, text: "unsent content" };
  assert.equal(refreshUneditedNewTaskDefaults(withText, view, defaults), withText);
});

test("unavailable configured models fall back without rewriting defaults", () => {
  const missing = { providerId: "removed", modelId: "gone" };
  const draft = initializeNewTaskDraft({ text: "", updatedAt: 0 }, "/repo", undefined, view, {
    modelSelection: missing,
  });
  assert.equal(draft.modelSelection?.providerId, "oauth-provider");
  assert.equal(draft.modelSelection?.modelId, "model");
  assert.deepEqual(missing, { providerId: "removed", modelId: "gone" });
});

test("explicit defaults take priority over accepted recent selections", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  captureComposerRecentSubmission(
    "/repo",
    {
      modelSelection: { ...selection, options: { reasoningLevel: "high", speed: "fast" } },
      mode: "yolo",
    },
    undefined,
    storage,
  )();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  try {
    const draft = initializeNewTaskDraft(
      { text: "", updatedAt: 0 },
      "/repo",
      undefined,
      view,
      defaults,
    );
    assert.deepEqual(draft.modelSelection, selection);
    assert.equal(draft.mode, "edit");
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("approval-only defaults keep normal model completion and do not revoke accepted permission grants", () => {
  const old = { text: "", mode: "build" as const, modelSelection: selection, updatedAt: 0 };
  const refreshed = refreshUneditedNewTaskDefaults(old, view, { approvalMode: "edit" });
  assert.equal(refreshed.mode, "edit");
  assert.equal(refreshed.modelSelection?.options?.speed, "fast");
  const granted = applyComposerPermissionGrant(old, { interactionId: "approval-one" });
  assert.equal(refreshUneditedNewTaskDefaults(granted, view, defaults).mode, "yolo");
});

test("deleted automatic models fall back to project Recent even without an explicit default", () => {
  const draft = {
    text: "",
    mode: "build" as const,
    modelSelection: { providerId: "deleted", modelId: "gone" },
    updatedAt: 0,
  };
  const next = refreshUneditedNewTaskDefaults(draft, view, {}, selection);
  assert.equal(next.modelSelection?.providerId, "oauth-provider");
  assert.equal(next.modelSelection?.modelId, "model");
  assert.equal(next.modelSelection?.options?.reasoningLevel, "high");
});

test("manual selection made before async initialization is preserved", () => {
  const manual = {
    text: "typed while loading",
    modelSelection: { ...selection, options: { reasoningLevel: "high", speed: "fast" } },
    modelSelectionEdited: true as const,
    updatedAt: 0,
  };
  const next = initializeNewTaskDraft(manual, "/repo", undefined, view, defaults);
  assert.deepEqual(next.modelSelection, manual.modelSelection);
  assert.equal(next.text, manual.text);
});
