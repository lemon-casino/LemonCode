import type { GitRemoteInfo, GitTagInfo, GitUnsupportedTagInfo } from "@lcode/shared";
import { ChevronDownIcon, LoaderIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getTagSuggestions, TAG_MODES, type PublishOptions } from "./publishModel.js";
import type { PublishPreset } from "./publishPresets.js";

export interface PublishOptionsPanelProps {
  expanded: boolean;
  options: PublishOptions;
  branchName: string | null;
  remotes: GitRemoteInfo[];
  tags: GitTagInfo[];
  unsupportedTags: GitUnsupportedTagInfo[];
  loading: boolean;
  error: string | null;
  disabled: boolean;
  canCommit: boolean;
  remainingGroups: number;
  presets: PublishPreset[];
  presetName: string;
  selectedPreset: string;
  onToggle: () => void;
  onReload: () => void;
  onChange: (options: PublishOptions) => void;
  onPreview: (withCommit: boolean) => void;
  onPresetNameChange: (name: string) => void;
  onPresetSelect: (name: string) => void;
  onPresetSave: () => void;
  onPresetApply: () => void;
  onPresetDelete: () => void;
}

export function GitPublishOptionsPanel(props: PublishOptionsPanelProps) {
  const { intl } = useLCodeIntl();
  const { options, disabled, tags } = props;
  const suggestions = getTagSuggestions(tags.map((tag) => tag.name));
  const creating = options.tagMode === "create" || options.tagMode === "create-and-push";
  const text = (key: string) => intl.formatMessage({ id: `git.publish.${key}` });
  const change = (patch: Partial<PublishOptions>) => props.onChange({ ...options, ...patch });
  return (
    <section className="min-w-0 border-t border-border">
      <Button
        type="button"
        data-testid="git-publish-toggle"
        variant="ghost"
        className="h-auto min-h-9 w-full justify-between whitespace-normal px-4 py-2"
        aria-expanded={props.expanded}
        disabled={disabled}
        onClick={props.onToggle}
      >
        {text("options")}
        <ChevronDownIcon className={props.expanded ? "size-4 rotate-180" : "size-4"} />
      </Button>
      {props.expanded ? (
        <div className="min-w-0 space-y-3 px-4 pb-4 text-ui-sm">
          <p className="text-foreground-subtle">{text("safeDefault")}</p>
          {props.loading ? (
            <p role="status" className="flex items-center gap-2">
              <LoaderIcon className="size-4 animate-spin" />
              {text("loading")}
            </p>
          ) : null}
          {props.error ? (
            <p role="alert" className="break-words text-destructive">
              {props.error}
            </p>
          ) : null}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-testid="git-publish-reload"
            disabled={disabled || props.loading}
            onClick={props.onReload}
          >
            {text("reload")}
          </Button>
          <fieldset disabled={disabled || props.loading} className="min-w-0 space-y-3">
            <legend className="sr-only">{text("options")}</legend>
            <label className="flex items-start gap-2 leading-6">
              <Checkbox
                className="mt-1"
                data-testid="git-publish-branch-enabled"
                checked={options.pushBranch}
                onCheckedChange={(checked) => change({ pushBranch: checked === true })}
              />
              <span>{text("pushBranch")}</span>
            </label>
            <div className="space-y-2">
              <p className="font-medium">{text("remotes")}</p>
              {!props.remotes.length && !props.loading ? (
                <p className="text-foreground-subtle">{text("noRemotes")}</p>
              ) : null}
              {props.remotes.map((remote) => {
                const selected = options.remotes.find((item) => item.name === remote.name);
                return (
                  <div
                    key={remote.name}
                    className="min-w-0 space-y-1 rounded-xl border border-border p-2"
                  >
                    <label className="flex min-w-0 items-start gap-2 leading-6">
                      <Checkbox
                        className="mt-1"
                        data-testid={`git-publish-remote-${remote.name}`}
                        checked={Boolean(selected)}
                        onCheckedChange={(checked) =>
                          change({
                            remotes:
                              checked === true
                                ? [
                                    ...options.remotes,
                                    { name: remote.name, branch: props.branchName ?? "" },
                                  ]
                                : options.remotes.filter((item) => item.name !== remote.name),
                          })
                        }
                      />
                      <span className="min-w-0 break-all font-mono">{remote.name}</span>
                    </label>
                    <p className="break-all text-foreground-subtle">{remote.url}</p>
                    {selected ? (
                      <label className="block min-w-0 space-y-1">
                        <span>{text("targetBranch")}</span>
                        <Input
                          data-testid={`git-publish-branch-${remote.name}`}
                          value={selected.branch}
                          disabled={!options.pushBranch || disabled}
                          aria-label={intl.formatMessage(
                            { id: "git.publish.targetBranchFor" },
                            { remote: remote.name },
                          )}
                          className="w-full min-w-0 text-mobile-input-safe md:text-ui-base"
                          onChange={(event) =>
                            change({
                              remotes: options.remotes.map((item) =>
                                item.name === remote.name
                                  ? { ...item, branch: event.target.value }
                                  : item,
                              ),
                            })
                          }
                        />
                      </label>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <div className="space-y-2">
              <p id="git-publish-tag-label" className="font-medium">
                {text("tags")}
              </p>
              <Select
                value={options.tagMode}
                onValueChange={(mode) => {
                  if (TAG_MODES.some((value) => value === mode))
                    change({ tagMode: mode as PublishOptions["tagMode"] });
                }}
                disabled={disabled}
              >
                <SelectTrigger
                  data-testid="git-publish-tag-mode"
                  aria-labelledby="git-publish-tag-label"
                  className="h-auto min-h-8 w-full min-w-0 whitespace-normal"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TAG_MODES.map((mode) => (
                    <SelectItem
                      key={mode}
                      value={mode}
                      data-testid={`git-publish-tag-mode-${mode}`}
                    >
                      {text(`tagMode.${mode}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {props.unsupportedTags.length ? (
                <div
                  data-testid="git-publish-unsupported-tags"
                  role="status"
                  className="min-w-0 space-y-1 text-foreground-subtle"
                >
                  <p>{text("unsupportedTags")}</p>
                  <ul className="max-h-32 overflow-y-auto font-mono">
                    {props.unsupportedTags.map((tag) => (
                      <li key={tag.name} className="break-all">
                        {tag.name} ({tag.objectType})
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {creating ? (
                <>
                  <label className="block space-y-1">
                    <span>{text("tagName")}</span>
                    <Input
                      data-testid="git-publish-tag-name"
                      className="text-mobile-input-safe md:text-ui-base"
                      value={options.tagName}
                      onChange={(event) =>
                        change({ tagName: event.target.value, tagStrategy: "custom" })
                      }
                    />
                  </label>
                  {suggestions ? (
                    <div className="flex flex-wrap gap-1">
                      {(["patch", "minor", "major"] as const).map((strategy) => (
                        <Button
                          type="button"
                          key={strategy}
                          variant="outline"
                          size="sm"
                          data-testid={`git-publish-version-${strategy}`}
                          onClick={() =>
                            change({ tagName: suggestions[strategy], tagStrategy: strategy })
                          }
                        >
                          {strategy}: {suggestions[strategy]}
                        </Button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-foreground-subtle">{text("manualTag")}</p>
                  )}
                  <p className="text-foreground-subtle">{text("lightweight")}</p>
                </>
              ) : null}
              {options.tagMode === "push-existing" ? (
                <div className="max-h-40 space-y-1 overflow-y-auto">
                  {!tags.length ? <p className="text-foreground-subtle">{text("noTags")}</p> : null}
                  {tags.map((tag) => (
                    <label key={tag.name} className="flex min-w-0 items-start gap-2 leading-6">
                      <Checkbox
                        className="mt-1"
                        data-testid={`git-publish-existing-tag-${tag.name}`}
                        checked={options.existingTags.includes(tag.name)}
                        onCheckedChange={(checked) =>
                          change({
                            existingTags:
                              checked === true
                                ? [...options.existingTags, tag.name]
                                : options.existingTags.filter((name) => name !== tag.name),
                          })
                        }
                      />
                      <span className="min-w-0 break-all font-mono">
                        {tag.name}{" "}
                        <span className="text-foreground-subtle">
                          {tag.commitHash.slice(0, 10)}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="space-y-2 border-t border-border pt-3">
              <p className="font-medium">{text("presets")}</p>
              <Input
                data-testid="git-publish-preset-name"
                aria-label={text("presetName")}
                placeholder={text("presetName")}
                maxLength={80}
                value={props.presetName}
                onChange={(event) => props.onPresetNameChange(event.target.value)}
                className="text-mobile-input-safe md:text-ui-base"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="git-publish-preset-save"
                disabled={!props.presetName.trim()}
                onClick={props.onPresetSave}
              >
                {text("presetSave")}
              </Button>
              {props.presets.length ? (
                <>
                  <Select
                    value={props.selectedPreset || undefined}
                    onValueChange={props.onPresetSelect}
                    disabled={disabled}
                  >
                    <SelectTrigger
                      data-testid="git-publish-preset-select"
                      aria-label={text("presets")}
                      className="w-full min-w-0"
                    >
                      <SelectValue placeholder={text("presetSelect")} />
                    </SelectTrigger>
                    <SelectContent>
                      {props.presets.map((preset) => (
                        <SelectItem key={preset.name} value={preset.name}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      data-testid="git-publish-preset-apply"
                      disabled={!props.selectedPreset}
                      onClick={props.onPresetApply}
                    >
                      {text("presetApply")}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      data-testid="git-publish-preset-delete"
                      disabled={!props.selectedPreset}
                      onClick={props.onPresetDelete}
                    >
                      {text("presetDelete")}
                    </Button>
                  </div>
                </>
              ) : null}
            </div>
          </fieldset>
          {props.remainingGroups > 1 ? (
            <p className="text-warning">
              {intl.formatMessage(
                { id: "git.publish.remainingGroups" },
                { count: props.remainingGroups },
              )}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              className="h-auto min-h-8 whitespace-normal"
              data-testid="git-publish-preview"
              disabled={disabled || props.loading || Boolean(props.error)}
              onClick={() => props.onPreview(false)}
            >
              {text("previewOnly")}
            </Button>
            <Button
              type="button"
              className="h-auto min-h-8 whitespace-normal"
              data-testid="git-publish-commit-preview"
              disabled={
                disabled ||
                props.loading ||
                Boolean(props.error) ||
                !props.canCommit ||
                props.remainingGroups > 1
              }
              onClick={() => props.onPreview(true)}
            >
              {text("previewCommit")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
