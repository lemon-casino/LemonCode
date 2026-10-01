import assert from "node:assert/strict";
import test from "node:test";
import * as toolbarFit from "./useComposerToolbarFit.js";

interface ControlBudget {
  priority: number;
  full: number;
  compact: number;
}

// 这里验证 fit 的测量决策与恢复，不把这些可控宽度当作浏览器几何证据。
function createToolbarBudget({
  availableWidth,
  fixedWidth = 0,
  controls: budgets = [],
  modelWidth,
  providerWidth = 0,
}: {
  availableWidth: number;
  fixedWidth?: number;
  controls?: ControlBudget[];
  modelWidth?: number;
  providerWidth?: number;
}) {
  const dataset: Record<string, string> = {};
  const properties = new Map<string, string>();
  const state = { availableWidth, fixedWidth };
  const style = {
    removeProperty: (name: string) => properties.delete(name),
    setProperty: (name: string, value: string) => properties.set(name, value),
    getPropertyValue: (name: string) => properties.get(name) ?? "",
  };
  const controls = budgets.map((budget) => {
    const controlDataset: Record<string, string> = {
      composerCollapsePriority: String(budget.priority),
    };
    return {
      dataset: controlDataset,
      getBoundingClientRect: () => ({
        width: controlDataset.composerCompact ? budget.compact : budget.full,
      }),
    };
  });
  const readModelWidth = () => {
    if (modelWidth === undefined) return 0;
    if (dataset.composerModelIcon) return 28;
    const naturalWidth = modelWidth + (dataset.composerProviderCompact ? 0 : providerWidth);
    return Math.min(
      naturalWidth,
      Number.parseFloat(style.getPropertyValue("--composer-model-max-width")) || naturalWidth,
    );
  };
  const content = {
    getBoundingClientRect: () => ({
      width:
        state.fixedWidth +
        controls.reduce((total, control) => total + control.getBoundingClientRect().width, 0) +
        readModelWidth(),
    }),
  };
  const elements: Record<string, unknown> = {
    "[data-composer-leading-actions]": {
      getBoundingClientRect: () => ({ width: state.availableWidth }),
    },
    "[data-composer-leading-content]": content,
    ".composer-model-trigger":
      modelWidth === undefined
        ? null
        : {
            getBoundingClientRect: () => ({ width: readModelWidth() }),
          },
  };
  const root = {
    dataset,
    style,
    querySelector: (selector: string) => elements[selector] ?? null,
    querySelectorAll: () => controls,
  } as unknown as HTMLElement;
  return { root, state, controls, dataset, style, content };
}

function fit(root: HTMLElement) {
  const measure = Reflect.get(toolbarFit, "fitComposerToolbar");
  assert.equal(
    typeof measure,
    "function",
    "the hook's DOM fit must be directly regression-testable",
  );
  measure(root);
}

test("wide toolbar keeps complete labels and clears stale compact/scroll projection", () => {
  const toolbar = createToolbarBudget({
    availableWidth: 800,
    fixedWidth: 120,
    controls: [{ priority: 0, full: 120, compact: 28 }],
    modelWidth: 220,
    providerWidth: 100,
  });
  toolbar.dataset.composerScroll = "true";
  toolbar.dataset.composerModelIcon = "true";
  toolbar.dataset.composerProviderCompact = "true";
  toolbar.controls[0]!.dataset.composerCompact = "true";
  toolbar.style.setProperty("--composer-model-max-width", "90px");
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerScroll, undefined);
  assert.equal(toolbar.dataset.composerModelIcon, undefined);
  assert.equal(toolbar.dataset.composerProviderCompact, undefined);
  assert.equal(toolbar.controls[0]!.dataset.composerCompact, undefined);
  assert.equal(toolbar.style.getPropertyValue("--composer-model-max-width"), "");
});

test("collapse priority is preserved and later controls stay expanded once the row fits", () => {
  const toolbar = createToolbarBudget({
    availableWidth: 190,
    controls: [
      { priority: 1, full: 90, compact: 28 },
      { priority: 0, full: 100, compact: 28 },
    ],
    modelWidth: 60,
  });
  fit(toolbar.root);
  assert.equal(toolbar.controls[0]!.dataset.composerCompact, undefined);
  assert.equal(toolbar.controls[1]!.dataset.composerCompact, "true");
  assert.equal(toolbar.dataset.composerScroll, undefined);
});

test("provider compacts before constraining model width and model icon is the last density step", () => {
  const toolbar = createToolbarBudget({
    availableWidth: 260,
    fixedWidth: 80,
    controls: [{ priority: 0, full: 100, compact: 28 }],
    modelWidth: 220,
    providerWidth: 100,
  });
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerProviderCompact, "true");
  assert.equal(toolbar.style.getPropertyValue("--composer-model-max-width"), "152px");
  assert.equal(toolbar.dataset.composerModelIcon, undefined);
  assert.equal(toolbar.dataset.composerScroll, undefined);
  toolbar.state.availableWidth = 140;
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerModelIcon, "true");
  assert.equal(toolbar.dataset.composerScroll, undefined);
});

test("no collapsible control still permits model compaction and bounded overflow", () => {
  const toolbar = createToolbarBudget({ availableWidth: 110, fixedWidth: 100, modelWidth: 240 });
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerModelIcon, "true");
  assert.equal(toolbar.dataset.composerScroll, "true");
});

test("no model still reaches the scroll terminal state instead of exiting early", () => {
  const toolbar = createToolbarBudget({
    availableWidth: 100,
    fixedWidth: 110,
    controls: [{ priority: 0, full: 90, compact: 28 }],
  });
  fit(toolbar.root);
  assert.equal(toolbar.controls[0]!.dataset.composerCompact, "true");
  assert.equal(toolbar.dataset.composerScroll, "true");
});

test("no model and no collapsible controls also get the same overflow terminal state", () => {
  const toolbar = createToolbarBudget({ availableWidth: 90, fixedWidth: 160 });
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerScroll, "true");
  toolbar.state.availableWidth = 160;
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerScroll, undefined);
});

test("a fully compact row recovers its labels when the real available budget grows", () => {
  const toolbar = createToolbarBudget({
    availableWidth: 100,
    fixedWidth: 150,
    controls: [{ priority: 0, full: 100, compact: 28 }],
    modelWidth: 220,
  });
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerScroll, "true");
  toolbar.state.availableWidth = 600;
  fit(toolbar.root);
  assert.equal(toolbar.dataset.composerScroll, undefined);
  assert.equal(toolbar.dataset.composerModelIcon, undefined);
  assert.equal(toolbar.controls[0]!.dataset.composerCompact, undefined);
  assert.equal(toolbar.style.getPropertyValue("--composer-model-max-width"), "");
});
