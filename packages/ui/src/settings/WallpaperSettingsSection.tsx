import { useRef } from "react";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useWallpaper } from "@/hooks/useWallpaper.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { WALLPAPER_SOURCES, type WallpaperSource } from "@/store/wallpaperStorage.js";
import { SettingsRow } from "./SettingsPageParts.js";

export function WallpaperSettingsSection() {
  const { intl } = useLCodeIntl();
  const { record, supported, busy, failed, select, importImage, builtinUrl } = useWallpaper();
  const input = useRef<HTMLInputElement>(null);
  const text = (key: string) => intl.formatMessage({ id: `settings.wallpaper.${key}` });
  if (!supported) return null;
  return (
    <div className="min-w-0 space-y-3" data-testid="wallpaper-settings">
      <h3 className="text-ui-lg font-semibold text-foreground">{text("title")}</h3>
      <p className="text-ui-base text-foreground-subtle">{text("description")}</p>
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardContent className="space-y-0 px-0">
          <SettingsRow
            label={text("source")}
            control={
              <Select
                value={record.source}
                disabled={busy}
                onValueChange={(value: WallpaperSource) => void select(value)}
              >
                <SelectTrigger aria-label={text("source")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLPAPER_SOURCES.map((source) => (
                    <SelectItem
                      key={source}
                      value={source}
                      disabled={
                        (source === "custom" && !record.image) ||
                        ((source === "baili" || source === "aemeath") && !builtinUrl(source))
                      }
                    >
                      {text(source)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
          <SettingsRow
            label={text("image")}
            control={
              <>
                <input
                  ref={input}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/avif"
                  className="hidden"
                  aria-label={text("chooseImage")}
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void importImage(file);
                  }}
                />
                <Button variant="outline" disabled={busy} onClick={() => input.current?.click()}>
                  {text("chooseImage")}
                </Button>
              </>
            }
          />
        </CardContent>
      </Card>
      {!builtinUrl("baili") ? (
        <p className="text-ui-caption text-foreground-subtle">{text("unavailable")}</p>
      ) : null}
      {failed ? (
        <p role="alert" className="text-ui-base text-destructive">
          {text("failed")}
        </p>
      ) : null}
    </div>
  );
}
