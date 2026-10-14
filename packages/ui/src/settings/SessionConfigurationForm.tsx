import { useState } from "react";
import {
  gitCommitReviewModeSchema,
  resolveProjectExecutionPolicy,
  resolveSessionDefaults,
  sessionApprovalModeSchema,
  type AppSettings,
  type ModelSelection,
  type ProjectExecutionPreference,
} from "@lcode/shared";
import { completeNewModelSelection } from "@lcode/provider";
import { useServices } from "@/hooks/useServices.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { thoughtLevelLabelId } from "@/chat-input-toolbar/thoughtLevelLabels.js";
import { GlobalExecutionPolicySettings } from "@/worktree/ExecutionPolicySettings.js";
import { SettingsGroupCard, SettingsRow } from "./SettingsPageParts.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";

const INHERIT = "__inherit__";
type DefaultPatch = Pick<
  ProjectExecutionPreference,
  | "defaultSessionModelSelection"
  | "defaultSessionApprovalMode"
  | "executionMode"
  | "gitCommitReviewMode"
>;

function ConfigurationSelect({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
  description,
}: {
  id: string;
  label: string;
  value: string;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  disabled: boolean;
  onChange: (value: string) => void;
  description?: string;
}) {
  return (
    <SettingsRow
      label={label}
      description={description}
      controlLayout="wide"
      control={
        <Select value={value} disabled={disabled} onValueChange={onChange}>
          <SelectTrigger
            size="lg"
            className="w-full"
            aria-label={label}
            data-testid={`configuration-${id}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((option) => (
              <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    />
  );
}

export function SessionConfigurationForm({
  project,
}: {
  project?: { workspacePath: string; workspaceIdentity?: string };
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.configuration.${key}` });
  const { settings, loading, update, error: readError } = useSettings();
  const { modelSelectionService } = useServices();
  const catalog = useModelSelectionServiceView(modelSelectionService);
  const view = catalog.state.status === "ready" ? catalog.state.view : null;
  const scope = project ? project.workspaceIdentity?.trim() || project.workspacePath : null;
  const preference = scope ? settings?.projectExecutionPreferences?.[scope] : settings;
  const selection = preference?.defaultSessionModelSelection;
  const effective = project
    ? resolveSessionDefaults(settings ?? {}, project)
    : { modelSelection: selection ?? undefined };
  const displayed = selection ?? effective.modelSelection;
  const providers = view?.providers ?? [];
  const provider = providers.find((item) => item.providerId === displayed?.providerId);
  const model = provider?.models.find((item) => item.modelId === displayed?.modelId);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabled = pending || loading || !settings;
  const automatic = text(project ? "inherit" : "automatic");
  const automaticOption = { value: INHERIT, label: automatic };
  const save = async (patch: DefaultPatch) => {
    setPending(true);
    setError(null);
    try {
      const globalPatch: Partial<AppSettings> = {
        ...("defaultSessionModelSelection" in patch
          ? { defaultSessionModelSelection: patch.defaultSessionModelSelection }
          : {}),
        ...("defaultSessionApprovalMode" in patch
          ? { defaultSessionApprovalMode: patch.defaultSessionApprovalMode }
          : {}),
      };
      await update(scope ? { projectExecutionPreferences: { [scope]: patch } } : globalPatch);
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const selectModel = (providerId: string, modelId: string) => {
    if (!view) return;
    const next = completeNewModelSelection(view, { providerId, modelId }, { speed: "highest" });
    if (next) void save({ defaultSessionModelSelection: next });
  };
  const selectOption = (key: "reasoningLevel" | "speed", value: string) => {
    if (!displayed) return;
    const next: ModelSelection = { ...displayed, options: { ...displayed.options, [key]: value } };
    void save({ defaultSessionModelSelection: next });
  };
  const missing = (value: string) => ({
    value,
    label: `${value} (${text("unavailable")})`,
    disabled: true,
  });
  const providerOptions = [
    automaticOption,
    ...providers.map((item) => ({
      value: item.providerId,
      label: `${item.providerName || item.providerId} · ${item.config.access?.type === "oauth-account" ? "OAuth" : "API"}`,
      disabled: !item.models.some(
        (candidate) => candidate.config.optionSpecs.reasoningLevel.values.length > 0,
      ),
    })),
  ];
  if (selection && !providers.some((item) => item.providerId === selection.providerId))
    providerOptions.push(missing(selection.providerId));
  const modelOptions = [
    automaticOption,
    ...(provider?.models.map((item) => ({ value: item.modelId, label: item.modelId })) ?? []),
  ];
  if (selection && !model) modelOptions.push(missing(selection.modelId));
  const optionChoices = (key: "reasoningLevel" | "speed") => {
    const values = model?.config.optionSpecs[key]?.values ?? [];
    const label = (value: string) => {
      const labelId =
        key === "reasoningLevel"
          ? thoughtLevelLabelId(value)
          : ["standard", "fast"].includes(value)
            ? `chat.toolbar.speed.${value}`
            : undefined;
      return labelId ? intl.formatMessage({ id: labelId }) : value;
    };
    const options: Array<{ value: string; label: string; disabled?: boolean }> = values.map(
      (value) => ({ value, label: label(value) }),
    );
    const selected = displayed?.options?.[key];
    if (selected && !values.includes(selected)) options.push(missing(selected));
    if (!options.length) options.push({ value: INHERIT, label: text("unsupported") });
    else if (!selected)
      options.unshift({ value: INHERIT, label: text("chooseOption"), disabled: true });
    return { options, selected: selected ?? INHERIT, supported: values.length > 0 };
  };
  const reasoning = optionChoices("reasoningLevel");
  const speed = optionChoices("speed");
  const policy = project ? resolveProjectExecutionPolicy(settings ?? {}, project) : null;
  const loadError = readError ?? (catalog.state.status === "error" ? catalog.state.error : null);
  return (
    <div className="min-w-0 space-y-4" data-testid="session-configuration-form">
      <p className="text-ui-base text-foreground-subtle">
        {text(project ? "projectDescription" : "description")}
      </p>
      <SettingsGroupCard>
        <ConfigurationSelect
          id="provider"
          label={text("provider")}
          value={selection?.providerId ?? INHERIT}
          options={providerOptions}
          disabled={disabled || !view}
          onChange={(value) => {
            if (value === INHERIT) void save({ defaultSessionModelSelection: null });
            else {
              const selectedProvider = providers.find((item) => item.providerId === value);
              const first = selectedProvider?.models.find(
                (item) => item.config.optionSpecs.reasoningLevel.values.length > 0,
              );
              if (first) selectModel(value, first.modelId);
            }
          }}
        />
        <ConfigurationSelect
          id="model"
          label={text("model")}
          value={selection?.modelId ?? INHERIT}
          options={modelOptions}
          disabled={disabled || !provider}
          onChange={(value) => {
            if (value === INHERIT) void save({ defaultSessionModelSelection: null });
            else if (provider) selectModel(provider.providerId, value);
          }}
        />
        <ConfigurationSelect
          id="reasoning"
          label={text("reasoning")}
          value={reasoning.selected}
          options={reasoning.options}
          disabled={disabled || !reasoning.supported}
          onChange={(value) => selectOption("reasoningLevel", value)}
        />
        <ConfigurationSelect
          id="approval"
          label={text("approval")}
          value={preference?.defaultSessionApprovalMode ?? INHERIT}
          options={[
            automaticOption,
            ...sessionApprovalModeSchema.options.map((value) => ({
              value,
              label: intl.formatMessage({ id: `mode.label.glm.${value}` }),
            })),
          ]}
          disabled={disabled}
          onChange={(value) =>
            void save({
              defaultSessionApprovalMode:
                value === INHERIT ? null : sessionApprovalModeSchema.parse(value),
            })
          }
        />
        <ConfigurationSelect
          id="speed"
          label={text("speed")}
          value={speed.selected}
          options={speed.options}
          disabled={disabled || !speed.supported}
          onChange={(value) => selectOption("speed", value)}
        />
      </SettingsGroupCard>
      <SettingsGroupCard>
        {project ? (
          <>
            <ConfigurationSelect
              id="execution"
              label={intl.formatMessage({ id: "worktree.defaultMode" })}
              description={intl.formatMessage({ id: "worktree.defaultModeDescription" })}
              value={settings?.projectExecutionPreferences?.[scope!]?.executionMode ?? "inherit"}
              options={["inherit", "local", "worktree"].map((value) => ({
                value,
                label: intl.formatMessage({ id: `worktree.mode.${value}` }),
              }))}
              disabled={disabled}
              onChange={(value) =>
                void save({ executionMode: value as ProjectExecutionPreference["executionMode"] })
              }
            />
            <ConfigurationSelect
              id="review"
              label={intl.formatMessage({ id: "settings.gitCommitReviewMode" })}
              description={intl.formatMessage({ id: "settings.gitCommitReviewModeDescription" })}
              value={policy?.gitCommitReviewPreference ?? "inherit"}
              options={[
                { value: "inherit", label: text("inherit") },
                ...gitCommitReviewModeSchema.options.map((value) => ({
                  value,
                  label: intl.formatMessage({ id: `settings.gitCommitReviewMode.${value}` }),
                })),
              ]}
              disabled={disabled}
              onChange={(value) =>
                void save({
                  gitCommitReviewMode: value as ProjectExecutionPreference["gitCommitReviewMode"],
                })
              }
            />
          </>
        ) : (
          <GlobalExecutionPolicySettings />
        )}
      </SettingsGroupCard>
      {error || loadError ? (
        <p role="alert" className="break-words text-ui-sm text-destructive">
          {error ?? getErrorMessage(loadError)}
        </p>
      ) : null}
    </div>
  );
}
