import { useEffect, useMemo, useRef, useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { completeNewModelSelection } from "@zcode/provider";
import type { ModelSelectionView } from "@zcode/services";
import {
  modelSelectionSchema,
  ZCODE_AGENT_PROVIDER,
  type ModelSelection,
} from "@zcode/shared";
import { ThoughtLevelCycleControl } from "@/chat-input-toolbar/ThoughtLevelCycleControl.js";
import { ModelSpeedControl } from "@/chat-input-toolbar/ModelSpeedControl.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { useModelSelectionView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";
import { encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { parseModelPickerValue } from "@/lib/zcodeSessionProjection.js";
import { ModelConfigSelect, type ModelSelectGroupItem } from "@/ModelConfigSelect.js";

const INHERIT_VALUE = "workflow-approval:inherit";
const MODEL_ITEM_NEVER_LOCKED = () => false;

export interface WorkflowActorLane {
  id: string;
  label: string;
}

export function WorkflowActorModelOverridesEditor({
  lanes,
  onModifiedInputChange,
  raw,
  requestId,
  workspacePath,
}: {
  lanes: readonly WorkflowActorLane[];
  onModifiedInputChange: (input: unknown) => void;
  raw: unknown;
  requestId: string;
  workspacePath?: string;
}) {
  const { intl } = useZCodeIntl();
  const modelRead = useModelSelectionView(workspacePath ?? "");
  const view = modelRead.state.status === "ready" ? modelRead.state.view : null;
  const groups = useMemo(
    () => (view === null ? [] : buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view)),
    [view],
  );
  const [draft, setDraft] = useState<Map<string, ModelSelection>>(() => readOverrides(raw));

  useEffect(() => {
    setDraft(readOverrides(raw));
  }, [raw, requestId]);

  const update = (siteId: string, selection: ModelSelection | undefined) => {
    const next = new Map(draft);
    if (selection === undefined) next.delete(siteId);
    else next.set(siteId, selection);
    setDraft(next);
    onModifiedInputChange(withOverrides(raw, lanes, next));
  };

  if (lanes.length === 0) return null;
  return (
    <section className="space-y-1.5" data-testid="workflow-actor-model-overrides">
      <div className="flex min-w-0 items-baseline justify-between gap-2">
        <h3 className="text-ui-sm font-medium text-foreground-subtle">
          {intl.formatMessage({ id: "chat.permission.workflow.actorModels" })}
        </h3>
        <span className="text-ui-xs text-foreground-subtlest">
          {intl.formatMessage(
            { id: "chat.permission.workflow.actorModels.changed" },
            { count: draft.size },
          )}
        </span>
      </div>
      <div className="max-h-52 divide-y divide-border overflow-y-auto border-y border-border">
        {lanes.map((lane) => (
          <WorkflowActorModelRow
            key={lane.id}
            groups={groups}
            label={lane.label}
            onChange={(selection) => update(lane.id, selection)}
            selection={draft.get(lane.id)}
            siteId={lane.id}
            view={view}
          />
        ))}
      </div>
      {modelRead.state.status === "error" ? (
        <p className="text-ui-xs text-warning" role="status">
          {intl.formatMessage({ id: "chat.permission.workflow.actorModels.unavailable" })}
        </p>
      ) : null}
    </section>
  );
}

function WorkflowActorModelRow({
  groups,
  label,
  onChange,
  selection,
  siteId,
  view,
}: {
  groups: ReturnType<typeof buildRegistryModelSelectGroups>;
  label: string;
  onChange: (selection: ModelSelection | undefined) => void;
  selection: ModelSelection | undefined;
  siteId: string;
  view: ModelSelectionView | null;
}) {
  const { intl } = useZCodeIntl();
  const thoughtTriggerRef = useRef<HTMLSpanElement | null>(null);
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const inheritLabel = intl.formatMessage({ id: "chat.permission.workflow.actorModels.inherit" });
  const inheritItem = useMemo<ModelSelectGroupItem>(
    () => ({ key: `${siteId}:inherit`, value: INHERIT_VALUE, name: inheritLabel }),
    [inheritLabel, siteId],
  );
  const leadingItems = useMemo(() => [inheritItem], [inheritItem]);
  const value =
    selection === undefined
      ? INHERIT_VALUE
      : encodeCustomModelValue(selection.providerId, selection.modelId);
  const thoughtOption =
    selection === undefined || view === null
      ? null
      : resolveModelThoughtOption({
          modelSelectionView: view,
          providerId: selection.providerId,
          modelId: selection.modelId,
          ...(selection.options?.reasoningLevel === undefined
            ? {}
            : { currentValue: selection.options.reasoningLevel }),
        });
  const speeds =
    selection === undefined || view === null
      ? []
      : (view.providers
          .find((provider) => provider.providerId === selection.providerId)
          ?.models.find((model) => model.modelId === selection.modelId)?.config.optionSpecs.speed
          ?.values ?? []);

  const setOption = (key: "reasoningLevel" | "speed", next: string) => {
    if (selection === undefined) return;
    onChange({ ...selection, options: { ...selection.options, [key]: next } });
  };

  return (
    <div className="grid min-w-0 grid-cols-[minmax(7rem,0.7fr)_minmax(10rem,1.3fr)_auto] items-center gap-2 py-2">
      <span className="truncate text-ui-sm text-foreground-subtle" title={label}>
        {label}
      </span>
      <ModelConfigSelect
        modelGroups={groups}
        normalizedValue={value}
        triggerLabel={selection?.modelId ?? inheritLabel}
        showManageModelsAction={false}
        lockReasonMessage=""
        isItemLocked={MODEL_ITEM_NEVER_LOCKED}
        onValueChange={(next) => {
          if (next === INHERIT_VALUE) {
            onChange(undefined);
            return;
          }
          if (view === null) return;
          const picked = parseModelPickerValue(next);
          const completed = completeNewModelSelection(view, picked);
          if (completed !== undefined) onChange(completed);
        }}
        leadingItems={leadingItems}
        contentSide="bottom"
        contentAlign="start"
        focusSelectorOnClose={null}
        labelVisibilityClassName="inline-flex min-w-0"
        triggerClassName="h-7 w-full min-w-0 justify-between rounded-md border border-input-border bg-input px-2 text-foreground"
        triggerLabelClassName="inline-flex min-w-0 flex-1 truncate text-left"
        triggerTestId={`workflow-actor-model-${siteId}`}
        disabled={view === null}
      />
      <div className="flex min-w-[4rem] items-center justify-end gap-0.5">
        {thoughtOption === null ? null : (
          <ThoughtLevelCycleControl
            intl={intl}
            option={thoughtOption}
            provider={ZCODE_AGENT_PROVIDER}
            onCurrentValueCommit={(level) => setOption("reasoningLevel", level)}
            showInvalidCurrentValue
            disabled={false}
            open={thoughtOpen}
            onOpenChange={setThoughtOpen}
            triggerRef={thoughtTriggerRef}
            restoreFocusSelector={null}
            labelVisibilityClassName="sr-only"
            triggerClassName="h-7 shrink-0 rounded-md px-1.5"
            onValueChange={(level) => setOption("reasoningLevel", level)}
          />
        )}
        {selection !== undefined && speeds.length > 0 ? (
          <ModelSpeedControl
            values={speeds}
            value={selection.options?.speed ?? speeds[0] ?? ""}
            disabled={false}
            open={speedOpen}
            onOpenChange={setSpeedOpen}
            onValueChange={(speed) => setOption("speed", speed)}
            intl={intl}
          />
        ) : null}
        {selection === undefined ? null : (
          <ControlHintTooltip
            title={intl.formatMessage({ id: "chat.permission.workflow.actorModels.reset" })}
          >
            <Button
              aria-label={intl.formatMessage({ id: "chat.permission.workflow.actorModels.reset" })}
              className="size-7 p-0"
              onClick={() => onChange(undefined)}
              size="icon"
              type="button"
              variant="ghost"
            >
              <RotateCcwIcon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        )}
      </div>
    </div>
  );
}

function readOverrides(raw: unknown): Map<string, ModelSelection> {
  const result = new Map<string, ModelSelection>();
  if (!isRecord(raw) || !Array.isArray(raw.actor_model_overrides)) return result;
  for (const item of raw.actor_model_overrides) {
    if (!isRecord(item) || typeof item.siteId !== "string") continue;
    const parsed = modelSelectionSchema.safeParse(item.selection);
    if (parsed.success) result.set(item.siteId, parsed.data);
  }
  return result;
}

function withOverrides(
  raw: unknown,
  lanes: readonly WorkflowActorLane[],
  overrides: ReadonlyMap<string, ModelSelection>,
): Record<string, unknown> {
  const next = isRecord(raw) ? { ...raw } : {};
  const values = lanes.flatMap((lane) => {
    const selection = overrides.get(lane.id);
    return selection === undefined ? [] : [{ siteId: lane.id, selection }];
  });
  if (values.length === 0) delete next.actor_model_overrides;
  else next.actor_model_overrides = values;
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
