import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelectionView } from "@lcode/services";
import {
  captureComposerRecentSubmission,
  readComposerRecent,
  resolveDraftInitialModelSelection,
} from "./composerRecent.js";
import {
  initializeNewTaskDraft,
  refreshUneditedNewTaskDefaults,
} from "../v4/composer/newTaskDraft.js";

const view = {
  providers: [
    {
      providerId: "custom",
      models: [
        {
          modelId: "demo",
          config: {
            optionSpecs: {
              reasoningLevel: { values: ["disabled", "low", "high"] },
              speed: { values: ["standard", "fast"] },
            },
          },
        },
      ],
    },
  ],
  preferredSelection: {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "low", speed: "standard" },
  },
} as unknown as ModelSelectionView;

test("new task uses the highest reasoning and speed instead of registry fallback preferences", () => {
  assert.deepEqual(resolveDraftInitialModelSelection(view, null).selection, {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "high", speed: "fast" },
  });
});

test("new task initializes both controls before the first submission", () => {
  assert.deepEqual(
    initializeNewTaskDraft({ text: "", updatedAt: 0 }, "workspace", undefined, view).modelSelection,
    {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  );
});

test("new task can choose the first available model when no preference is configured", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection({ ...view, preferredSelection: undefined }, null).selection,
    {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "high", speed: "fast" },
    },
  );
});

test("a new task keeps the recent model but defaults to its highest reasoning and speed", () => {
  const identity = { providerId: "custom", modelId: "demo" };
  assert.deepEqual(
    resolveDraftInitialModelSelection(view, {
      ...identity,
      options: { reasoningLevel: "low", speed: "standard" },
    }).selection,
    { ...identity, options: { reasoningLevel: "high", speed: "fast" } },
  );
  assert.deepEqual(
    resolveDraftInitialModelSelection(view, {
      ...identity,
      options: { reasoningLevel: "low" },
    }).selection,
    { ...identity, options: { reasoningLevel: "high", speed: "fast" } },
  );
});

test("a recent speed is not a preference for the next task", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(view, {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "low", speed: "unsupported" },
    }),
    {
      selection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "high", speed: "fast" },
      },
      invalidated: false,
    },
  );
});

test("a removed recent model falls back to the current catalog default", () => {
  assert.deepEqual(
    resolveDraftInitialModelSelection(view, { providerId: "deleted", modelId: "gone" }),
    {
      selection: {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "high", speed: "fast" },
      },
      invalidated: true,
    },
  );
});

test("new task uses current catalog defaults even when a prior option was unsupported", () => {
  const storage = {
    getItem: () =>
      JSON.stringify({
        modelSelection: {
          providerId: "custom",
          modelId: "demo",
          options: { reasoningLevel: "low", speed: "unsupported" },
        },
        mode: "build",
      }),
    setItem: () => {},
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  try {
    assert.deepEqual(
      initializeNewTaskDraft({ text: "", updatedAt: 0 }, "workspace", undefined, view)
        .modelSelection,
      {
        providerId: "custom",
        modelId: "demo",
        options: { reasoningLevel: "high", speed: "fast" },
      },
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("old empty root draft upgrades standard, but manually selected standard remains", () => {
  const old = {
    text: "",
    mode: "build" as const,
    updatedAt: 0,
    modelSelection: {
      providerId: "custom",
      modelId: "demo",
      options: { reasoningLevel: "low", speed: "standard" },
    },
  };
  assert.deepEqual(refreshUneditedNewTaskDefaults(old, view).modelSelection?.options, {
    reasoningLevel: "high",
    speed: "fast",
  });
  assert.equal(
    refreshUneditedNewTaskDefaults({ ...old, modelSelectionEdited: true }, view).modelSelection,
    old.modelSelection,
  );
  assert.equal(
    refreshUneditedNewTaskDefaults({ ...old, text: "draft" }, view).modelSelection,
    old.modelSelection,
  );
});

test("accepted recent submissions persist both reasoning and speed", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const selection = {
    providerId: "custom",
    modelId: "demo",
    options: { reasoningLevel: "low", speed: "standard" },
  };
  captureComposerRecentSubmission(
    "workspace",
    { modelSelection: selection, mode: "build" },
    undefined,
    storage,
  )();
  assert.deepEqual(readComposerRecent("workspace", undefined, storage)?.modelSelection, selection);
});
