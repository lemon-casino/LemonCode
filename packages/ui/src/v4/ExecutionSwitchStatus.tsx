import type { ModelSelection } from "@zcode/shared";
import type { ExecutionFailoverState } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
import { useZCodeIntl, type IntlInstance } from "@/i18n/IntlProvider.js";
import { resolveProviderLabel } from "@/lib/registryProviderView.js";
import { formatModelChangeLabel } from "@/v4/composer/modelTriggerDisplay.js";
import { resolveExecutionSwitchDisplay } from "@/v4/executionFailoverUi.js";

function formatReasoningLevel(value: string, intl: IntlInstance): string {
  const labelId = thoughtLevelLabelId(value);
  return labelId ? intl.formatMessage({ id: labelId }) : value.trim();
}

function formatSpeed(value: string, intl: IntlInstance): string {
  switch (value.trim().toLowerCase()) {
    case "standard":
      return intl.formatMessage({ id: "chat.toolbar.speed.standard" });
    case "fast":
      return intl.formatMessage({ id: "chat.toolbar.speed.fast" });
    default:
      return value.trim();
  }
}

function formatSelection(
  selection: ModelSelection | null,
  modelSelectionView: ModelSelectionView | null,
  intl: IntlInstance,
): string {
  if (!selection) return intl.formatMessage({ id: "chat.executionSwitch.currentUnknown" });
  const providerLabel = resolveProviderLabel(selection.providerId, modelSelectionView);
  const modelLabel = formatModelChangeLabel(
    selection.providerId,
    providerLabel,
    selection.modelId,
    intl,
  );
  const optionLabels: string[] = [];
  if (selection.options?.reasoningLevel) {
    optionLabels.push(
      intl.formatMessage(
        { id: "chat.executionSwitch.reasoningOption" },
        { value: formatReasoningLevel(selection.options.reasoningLevel, intl) },
      ),
    );
  }
  if (selection.options?.speed) {
    optionLabels.push(
      intl.formatMessage(
        { id: "chat.executionSwitch.speedOption" },
        { value: formatSpeed(selection.options.speed, intl) },
      ),
    );
  }
  if (optionLabels.length === 0) return modelLabel;
  return intl.formatMessage(
    { id: "chat.executionSwitch.selectionWithOptions" },
    {
      model: modelLabel,
      options: optionLabels.join(
        intl.formatMessage({ id: "chat.executionSwitch.optionSeparator" }),
      ),
    },
  );
}

export function ExecutionSwitchStatus({
  currentSelection,
  modelSelectionView,
  state,
}: {
  currentSelection?: ModelSelection | null;
  modelSelectionView: ModelSelectionView | null;
  state: ExecutionFailoverState;
}) {
  const { intl } = useZCodeIntl();
  const display = resolveExecutionSwitchDisplay(state, currentSelection);
  if (!display) return null;

  const message =
    display.kind === "active"
      ? intl.formatMessage(
          { id: "chat.executionSwitch.active" },
          {
            fromModel: formatSelection(display.from, modelSelectionView, intl),
            toModel: formatSelection(display.to, modelSelectionView, intl),
          },
        )
      : intl.formatMessage(
          {
            id:
              display.kind === "switching"
                ? "chat.executionSwitch.switching"
                : display.kind === "blocked"
                  ? "chat.executionSwitch.blocked"
                  : "chat.executionSwitch.waitingSafeBoundary",
          },
          {
            currentModel: formatSelection(display.currentSelection, modelSelectionView, intl),
            targetModel: formatSelection(display.targetSelection, modelSelectionView, intl),
          },
        );

  return (
    <div
      role="status"
      aria-live="polite"
      data-execution-switch-status={display.kind}
      className="flex min-w-0 items-center px-3 pb-1.5 text-ui-sm text-foreground-subtle"
    >
      <span className="min-w-0 truncate">{message}</span>
    </div>
  );
}
