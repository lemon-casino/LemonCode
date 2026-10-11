import { useState } from "react";
import type { WorktreeManagementSettings } from "@lcode/shared";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useSelectDirectory } from "@/hooks/usePlatform.js";
import { SettingsRow } from "./SettingsPageParts.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from "@/components/ui/select.js";

export function WorktreeGeneralSettings({
  settings,
  pending,
  save,
  canSelectDirectory,
}: {
  settings: WorktreeManagementSettings;
  pending: boolean;
  save: (patch: Partial<WorktreeManagementSettings>) => Promise<boolean>;
  canSelectDirectory: boolean;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.worktrees.${key}` });
  const selectDirectory = useSelectDirectory();
  const [count, setCount] = useState(String(settings.retainedCount));
  const [root, setRoot] = useState(settings.rootDirectory);
  const [pickerError, setPickerError] = useState<string>();
  const validCount = Number.isInteger(Number(count)) && Number(count) >= 1 && Number(count) <= 1000;
  return (
    <section
      aria-label={text("general")}
      className="min-w-0 space-y-3"
      data-testid="worktree-general-settings"
    >
      <h3 className="text-ui-lg font-medium">{text("general")}</h3>
      <div className="overflow-hidden rounded-xl border border-border">
        <SettingsRow
          label={text("autoDelete")}
          description={text("autoDeleteDescription")}
          control={
            <Switch
              aria-label={text("autoDelete")}
              checked={settings.autoDeleteEnabled}
              disabled={pending}
              onCheckedChange={(value) => void save({ autoDeleteEnabled: value })}
            />
          }
        />
        <SettingsRow
          label={text("retainedCount")}
          description={text("retainedCountDescription")}
          control={
            <div className="flex min-w-0 gap-2">
              <Input
                type="number"
                min={1}
                max={1000}
                aria-label={text("retainedCount")}
                value={count}
                disabled={pending}
                onChange={(event) => setCount(event.target.value)}
                className="w-20"
              />
              <Button
                variant="outline"
                disabled={pending || !validCount || Number(count) === settings.retainedCount}
                onClick={() => void save({ retainedCount: Number(count) })}
              >
                {intl.formatMessage({ id: "common.save" })}
              </Button>
            </div>
          }
        />
        <SettingsRow
          controlLayout="wide"
          label={text("rootDirectory")}
          description={text("rootDescription")}
          control={
            <Select
              value={settings.rootLocation}
              disabled={pending}
              onValueChange={(rootLocation) =>
                void save({
                  rootLocation: rootLocation as WorktreeManagementSettings["rootLocation"],
                })
              }
            >
              <SelectTrigger className="w-full" aria-label={text("rootDirectory")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(["default", "project", "custom"] as const).map((value) => (
                  <SelectItem key={value} value={value}>
                    {text(`root.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        {settings.rootLocation === "custom" ? (
          <div className="flex min-w-0 flex-wrap gap-2 border-t border-border px-4 py-3">
            <Input
              className="min-w-0 flex-1 basis-48"
              aria-label={text("customRoot")}
              placeholder={text("rootPlaceholder")}
              value={root}
              disabled={pending}
              onChange={(event) => setRoot(event.target.value)}
            />
            {canSelectDirectory ? (
              <Button
                variant="outline"
                disabled={pending}
                onClick={() =>
                  void selectDirectory()
                    .then((path) => {
                      if (path) setRoot(path);
                    })
                    .catch((reason) => setPickerError(String(reason)))
                }
              >
                {text("browse")}
              </Button>
            ) : null}
            <Button
              variant="outline"
              disabled={pending || root === settings.rootDirectory}
              onClick={() => void save({ rootDirectory: root })}
            >
              {intl.formatMessage({ id: "common.save" })}
            </Button>
          </div>
        ) : null}
      </div>
      {pickerError ? (
        <p role="alert" className="text-ui-sm text-destructive">
          {pickerError}
        </p>
      ) : null}
    </section>
  );
}
