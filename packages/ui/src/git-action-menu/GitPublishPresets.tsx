import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import type { PublishPreset } from "./publishPresets.js";

export interface GitPublishPresetControls {
  presets: PublishPreset[];
  presetName: string;
  selectedPreset: string;
  onPresetNameChange: (name: string) => void;
  onPresetSelect: (name: string) => void;
  onPresetSave: () => void;
  onPresetApply: () => void;
  onPresetDelete: () => void;
}

export function GitPublishPresets(props: GitPublishPresetControls & { disabled: boolean }) {
  const { intl } = useLCodeIntl();
  const disabled = props.disabled;
  const text = (key: string) => intl.formatMessage({ id: "git.publish." + key });
  return (
    <details className="space-y-2 border-t border-border pt-3" data-testid="git-publish-presets">
      <summary className="cursor-pointer font-medium">{text("presets")}</summary>
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
    </details>
  );
}
