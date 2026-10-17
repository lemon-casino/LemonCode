import { Input } from "@/components/ui/input.js";
import type { StartupSceneSettings } from "@lcode/shared/startup-animation";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";

/** 只展示当前字幕选择；草稿与增删命令仍由制作区唯一持有。 */
export function StartupSubtitlePicker({
  subtitles,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
}: {
  subtitles: StartupSceneSettings["subtitles"];
  selectedId?: string;
  onSelect(id: string): void;
  onAdd(): void;
  onRemove(): void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.startupScene.${key}` });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={selectedId ?? ""} disabled={!selectedId} onValueChange={onSelect}>
        <SelectTrigger aria-label={text("subtitles")}>
          <SelectValue placeholder={text("subtitles")} />
        </SelectTrigger>
        <SelectContent>
          {subtitles.map((cue, index) => (
            <SelectItem key={cue.id} value={cue.id}>
              {intl.formatMessage(
                { id: "settings.startupScene.subtitleItem" },
                { number: index + 1 },
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" disabled={subtitles.length >= 8} onClick={onAdd}>
        {text("addSubtitle")}
      </Button>
      <Button variant="outline" size="sm" disabled={!selectedId} onClick={onRemove}>
        {text("removeSubtitle")}
      </Button>
    </div>
  );
}

export function StartupSubtitleTiming({
  subtitle,
  changeSubtitle,
}: {
  subtitle?: StartupSceneSettings["subtitles"][number];
  changeSubtitle(patch: Partial<StartupSceneSettings["subtitles"][number]>): void;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: "settings.startupScene." + key });
  return subtitle ? (
    <>
      <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
        {text("subtitleStart")}
        <Input
          aria-label={text("subtitleStart")}
          type="number"
          min={0}
          max={35.9}
          step={0.1}
          value={subtitle.start}
          onChange={(event) => {
            const start = Math.max(0, Math.min(35.9, Number(event.target.value)));
            changeSubtitle({
              start,
              end: subtitle.end === undefined ? undefined : Math.max(start + 0.1, subtitle.end),
            });
          }}
        />
      </label>
      <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
        {text("subtitleEnd")}
        <Input
          aria-label={text("subtitleEnd")}
          type="number"
          min={subtitle.start + 0.1}
          max={36}
          step={0.1}
          value={subtitle.end ?? ""}
          placeholder={text("untilEnd")}
          onChange={(event) =>
            changeSubtitle({
              end:
                event.target.value === ""
                  ? undefined
                  : Math.max(subtitle.start + 0.1, Math.min(36, Number(event.target.value))),
            })
          }
        />
      </label>
    </>
  ) : null;
}
