import React from "react";
import { visibleModelOptionWindow } from "./app-input.js";
import { palette } from "./app-model.js";
import { modelOptionValue } from "./app-model-ref.js";
import { displayWidth, truncateDisplay } from "./app-terminal-width.js";
import type { TuiModelOption } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const MODEL_OPTION_VISIBLE_COUNT = 8;
const MODEL_OPTION_PANEL_CHROME_ROWS = 2;
const MODEL_OPTION_ROW_HEIGHT = 1;
const MODEL_ROW_SELECTOR_WIDTH = 2;
const MODEL_ROW_PROVIDER_GAP_WIDTH = 2;
const MODEL_ROW_MIN_CONTENT_WIDTH = 8;
const MODEL_ROW_MIN_MODEL_WIDTH = 8;
const MODEL_ROW_FALLBACK_CONTENT_WIDTH = 80;
const MODEL_ROW_MAX_PROVIDER_RATIO = 0.4;

type ModelOptionDisplayParts = {
  meta: string;
  model: string;
  provider: string;
};

type FittedModelOptionRow = {
  meta: string;
  model: string;
  provider: string;
  providerWidth: number;
};

export function ModelSuggestionPanel({
  contentWidth,
  currentModel,
  models,
  selectedIndex,
}: {
  contentWidth?: number;
  currentModel: string;
  models: readonly TuiModelOption[];
  selectedIndex: number;
}): React.ReactElement | null {
  const visible = visibleModelOptionWindow(models, selectedIndex, MODEL_OPTION_VISIBLE_COUNT);
  const rowContentWidth = normalizeModelRowContentWidth(contentWidth);
  const rows =
    visible.models.length > 0
      ? visible.models.map((model, index) => ({
          current: modelOptionValue(model) === currentModel,
          fitted: fitModelOptionRow(
            modelOptionDisplayParts(model, modelOptionValue(model) === currentModel),
            rowContentWidth,
          ),
          model,
          selected: index === visible.selectedIndex,
        }))
      : [];
  const panelHeight =
    MODEL_OPTION_PANEL_CHROME_ROWS + Math.max(1, rows.length) * MODEL_OPTION_ROW_HEIGHT;

  return h(
    "box",
    {
      title: "Models",
      style: {
        backgroundColor: palette.panel,
        border: true,
        borderColor: palette.border,
        flexDirection: "column",
        height: panelHeight,
        marginBottom: 1,
        paddingLeft: 1,
        paddingRight: 1,
        width: "100%",
      },
    },
    rows.length > 0
      ? rows.map((row) =>
          h(ModelSuggestionRow, {
            key: JSON.stringify(row.model.ref),
            fitted: row.fitted,
            selected: row.selected,
          }),
        )
      : h(
          "text",
          {
            style: {
              fg: palette.warning,
              height: MODEL_OPTION_ROW_HEIGHT,
              width: "100%",
            },
          },
          "No matching models.",
        ),
  );
}

function ModelSuggestionRow({
  fitted,
  selected,
}: {
  fitted: FittedModelOptionRow;
  selected: boolean;
}): React.ReactElement {
  return h(
    "box",
    {
      style: {
        alignItems: "center",
        flexDirection: "row",
        height: MODEL_OPTION_ROW_HEIGHT,
        width: "100%",
      },
    },
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.muted,
          flexShrink: 0,
          width: MODEL_ROW_SELECTOR_WIDTH,
        },
      },
      selected ? "> " : "  ",
    ),
    h(
      "text",
      {
        style: {
          fg: selected ? palette.accent : palette.text,
          flexShrink: 1,
          minWidth: 1,
        },
      },
      fitted.model,
    ),
    fitted.meta
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
            },
          },
          fitted.meta,
        )
      : null,
    h("box", {
      style: {
        flexGrow: 1,
        minWidth: fitted.provider ? MODEL_ROW_PROVIDER_GAP_WIDTH : 0,
      },
    }),
    fitted.provider
      ? h(
          "text",
          {
            style: {
              fg: palette.muted,
              flexShrink: 0,
              width: fitted.providerWidth,
            },
          },
          fitted.provider,
        )
      : null,
  );
}

function modelOptionDisplayParts(model: TuiModelOption, current: boolean): ModelOptionDisplayParts {
  const modelName = model.label || model.ref.modelId;
  const meta = [model.disabledReason, current ? "current" : undefined].filter(Boolean).join(" | ");
  return {
    meta,
    model: modelName,
    provider: model.providerLabel || model.ref.providerId,
  };
}

function fitModelOptionRow(
  parts: ModelOptionDisplayParts,
  contentWidth: number,
): FittedModelOptionRow {
  const providerBudget = providerColumnBudget(parts.provider, contentWidth);
  const provider = truncateDisplay(parts.provider, providerBudget);
  const providerWidth = displayWidth(provider);
  const providerGapWidth = provider ? MODEL_ROW_PROVIDER_GAP_WIDTH : 0;
  const leftBudget = Math.max(
    0,
    contentWidth - MODEL_ROW_SELECTOR_WIDTH - providerGapWidth - providerWidth,
  );
  const meta = parts.meta ? `  ${parts.meta}` : "";
  const metaWidth = displayWidth(meta);
  const showMeta = metaWidth > 0 && leftBudget - metaWidth >= MODEL_ROW_MIN_MODEL_WIDTH;
  const modelBudget = Math.max(0, leftBudget - (showMeta ? metaWidth : 0));

  return {
    meta: showMeta ? meta : "",
    model: truncateDisplay(parts.model, modelBudget),
    provider,
    providerWidth,
  };
}

function providerColumnBudget(provider: string, contentWidth: number): number {
  if (!provider) return 0;
  const providerMax = Math.floor(contentWidth * MODEL_ROW_MAX_PROVIDER_RATIO);
  const providerBudget =
    contentWidth -
    MODEL_ROW_SELECTOR_WIDTH -
    MODEL_ROW_PROVIDER_GAP_WIDTH -
    MODEL_ROW_MIN_MODEL_WIDTH;
  return Math.max(0, Math.min(providerMax, providerBudget));
}

function normalizeModelRowContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) {
    return MODEL_ROW_FALLBACK_CONTENT_WIDTH;
  }
  return Math.max(MODEL_ROW_MIN_CONTENT_WIDTH, Math.floor(contentWidth));
}
