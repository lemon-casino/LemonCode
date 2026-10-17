import { Button } from "@/components/ui/button.js";
import {
  STARTUP_ANIMATION_CHOICES,
  getStartupAnimationChoice,
  getStartupScene,
  startupAnimationChoicePatch,
  type StartupAnimationChoice,
} from "@lcode/shared/startup-animation";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useStartupAnimationSettings } from "@/hooks/useStartupAnimationSettings.js";
import { SettingsRow } from "./SettingsPageParts.js";
import { useState } from "react";
import { StartupSceneEditor } from "./StartupSceneEditor.js";

export function StartupAnimationSettingsSection() {
  const { intl } = useLCodeIntl();
  const { value, availablePresets, busy, failed, save, preview } = useStartupAnimationSettings();
  const text = (key: string) => intl.formatMessage({ id: `settings.startupAnimation.${key}` });
  const [editing, setEditing] = useState(false);
  return (
    <div className="min-w-0 space-y-3" data-testid="startup-animation-settings">
      <h3 className="text-ui-lg font-semibold text-foreground">{text("title")}</h3>
      <p className="text-ui-base text-foreground-subtle">{text("description")}</p>
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          <SettingsRow
            label={text("selection")}
            control={
              <Select
                value={getStartupAnimationChoice(value)}
                disabled={busy}
                onValueChange={(choice: StartupAnimationChoice) =>
                  void save(startupAnimationChoicePatch(choice))
                }
              >
                <SelectTrigger aria-label={text("selection")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STARTUP_ANIMATION_CHOICES.map((choice) => (
                    <SelectItem
                      key={choice}
                      value={choice}
                      disabled={
                        choice !== "official" &&
                        choice !== "off" &&
                        !availablePresets.includes(choice)
                      }
                    >
                      {text(choice)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={text("volume")}
            control={
              <Select
                value={String(value.volume)}
                disabled={busy || value.mode !== "cinematic" || Boolean(getStartupScene(value))}
                onValueChange={(volume) => void save({ volume: Number(volume) })}
              >
                <SelectTrigger aria-label={text("volume")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[0, 0.25, 0.5, 0.75, 1].map((volume) => (
                    <SelectItem key={volume} value={String(volume)}>
                      {volume === 0 ? text("muted") : `${volume * 100}%`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={text("preview")}
            control={
              <Button variant="outline" disabled={busy || value.mode === "off"} onClick={preview}>
                {text("preview")}
              </Button>
            }
          />
        </CardContent>
      </Card>
      {value.mode === "cinematic" ? (
        <>
          <Button variant="outline" onClick={() => setEditing(!editing)} aria-expanded={editing}>
            {intl.formatMessage({ id: "settings.startupScene.title" })}
          </Button>
          {editing ? <StartupSceneEditor key={value.preset} value={value} save={save} /> : null}
        </>
      ) : null}
      {failed ? (
        <p role="alert" className="text-ui-base text-foreground">
          {text("saveFailed")}
        </p>
      ) : null}
    </div>
  );
}
