import { useState, type CSSProperties } from "react";
import { StartupSubtitlePicker, StartupSubtitleTiming } from "./StartupSubtitlePicker.js";
import {
  SCENE_EASINGS,
  sceneEase,
  type StartupAnimationSettings,
} from "@lcode/shared/startup-animation";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { useStartupSceneEditor } from "@/hooks/useStartupSceneEditor.js";

// 控件随 UI 字号自然增高，颜色输入与原生文件框也使用同一基线高度。
const controlSize = {
  "--startup-control-height": "max(2.25rem, calc(var(--ui-font-size) * 1.625 + 0.375rem))",
} as CSSProperties;

export function StartupSceneEditor({
  value,
  save,
}: {
  value: StartupAnimationSettings;
  save: (patch: Partial<StartupAnimationSettings>) => Promise<boolean>;
}) {
  const { intl } = useLCodeIntl();
  const text = (key: string) => intl.formatMessage({ id: `settings.startupScene.${key}` });
  const editor = useStartupSceneEditor(value, save),
    { draft, change } = editor;
  const [layer, setLayer] = useState<"titlePosition" | "subtitlePosition" | "imagePosition">(
    "titlePosition",
  );
  const [subtitleId, setSubtitleId] = useState(draft.subtitles[0]?.id ?? "");
  const subtitle = draft.subtitles.find((cue) => cue.id === subtitleId) ?? draft.subtitles[0];
  const position =
    layer === "subtitlePosition" ? (subtitle?.position ?? { x: 7, y: 90 }) : draft[layer];
  const changeSubtitle = (patch: Partial<(typeof draft.subtitles)[number]>) => {
    if (!subtitle) return;
    change({
      ...draft,
      subtitles: draft.subtitles.map((cue) =>
        cue.id === subtitle.id ? { ...cue, ...patch } : cue,
      ),
    });
  };
  const easingCurve = Array.from(
    { length: 41 },
    (_, i) => `${i * 3},${50 - sceneEase(draft.easing, i / 40) * 40}`,
  ).join(" ");
  const move = (x: number, y: number) => {
    const next = { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
    if (layer === "subtitlePosition") changeSubtitle({ position: next });
    else change({ ...draft, [layer]: next });
  };
  return (
    <Card data-testid="startup-scene-editor" className="min-w-0 border-border bg-card shadow-none">
      <CardContent
        style={controlSize}
        className="space-y-4 p-4 [&_input:not([type=range])]:min-h-[var(--startup-control-height)] [&_[data-slot=select-trigger]]:min-h-[var(--startup-control-height)] [&_[data-slot=select-trigger]]:py-0.5 [&_[data-slot=button]]:min-h-[var(--startup-control-height)] [&_[data-slot=button]]:py-0.5"
      >
        <h4 className="text-ui-base font-semibold">{text("title")}</h4>
        <p className="text-ui-caption text-foreground-subtle">{text("description")}</p>
        <div
          className="relative aspect-video w-full overflow-hidden rounded-lg border border-border"
          data-testid="startup-scene-stage"
        >
          <div ref={editor.container} className="absolute inset-0" />
          <button
            type="button"
            aria-label={text("drag")}
            disabled={layer === "subtitlePosition" && !subtitle}
            className="absolute z-10 touch-none rounded border border-dashed border-white/80 bg-black/60 px-2 py-1 text-ui-xs text-white cursor-move"
            style={{ left: `${position.x}%`, top: `${position.y}%`, transform: "translateY(-50%)" }}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
              const box = event.currentTarget.parentElement!.getBoundingClientRect();
              move(
                ((event.clientX - box.left) / box.width) * 100,
                ((event.clientY - box.top) / box.height) * 100,
              );
            }}
            onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            onKeyDown={(event) => {
              const offset = event.shiftKey ? 5 : 1;
              if (event.key.startsWith("Arrow")) {
                event.preventDefault();
                move(
                  position.x +
                    (event.key === "ArrowRight" ? offset : event.key === "ArrowLeft" ? -offset : 0),
                  position.y +
                    (event.key === "ArrowDown" ? offset : event.key === "ArrowUp" ? -offset : 0),
                );
              }
            }}
          >
            {text(
              layer === "titlePosition"
                ? "headline"
                : layer === "subtitlePosition"
                  ? "subtitle"
                  : "imagePosition",
            )}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={editor.play}>
            {text("play")}
          </Button>
          <Button variant="outline" size="sm" onClick={editor.pause}>
            {text("pause")}
          </Button>
          <Button variant="outline" size="sm" onClick={editor.preview} disabled={editor.busy}>
            {text("preview")}
          </Button>
          <span data-testid="startup-scene-clock" className="text-ui-caption tabular-nums">
            {editor.time.toFixed(1)} / {editor.duration.toFixed(1)}s
          </span>
        </div>
        <input
          type="range"
          aria-label={text("timeline")}
          min={0}
          max={editor.duration}
          step={0.01}
          value={Math.min(editor.time, editor.duration)}
          onChange={(event) => editor.seek(Number(event.currentTarget.value))}
          className="w-full accent-primary"
        />
        <StartupSubtitlePicker
          subtitles={draft.subtitles}
          selectedId={subtitle?.id}
          onSelect={(id) => {
            setSubtitleId(id);
            setLayer("subtitlePosition");
          }}
          onAdd={() => {
            const id = crypto.randomUUID();
            change({
              ...draft,
              subtitles: [
                ...draft.subtitles,
                {
                  id,
                  text: "",
                  position: { x: 7, y: Math.min(95, 65 + draft.subtitles.length * 5) },
                  size: 22,
                  start: 0,
                },
              ],
            });
            setSubtitleId(id);
            setLayer("subtitlePosition");
          }}
          onRemove={() =>
            change({
              ...draft,
              subtitles: draft.subtitles.filter((cue) => cue.id !== subtitle?.id),
            })
          }
        />
        <div
          className="grid min-w-0 grid-cols-1 items-start gap-3 sm:grid-cols-2"
          data-testid="startup-scene-fields"
        >
          <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
            {text("headline")}
            <Input aria-label={text("headline")} value={draft.title} readOnly />
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
            {text("subtitle")}
            <Input
              aria-label={text("subtitle")}
              value={subtitle?.text ?? ""}
              disabled={!subtitle}
              maxLength={120}
              onChange={(event) => changeSubtitle({ text: event.target.value })}
            />
          </label>
          <div className="flex min-w-0 flex-col gap-1 text-ui-caption">
            {text("element")}
            <Select value={layer} onValueChange={(next: typeof layer) => setLayer(next)}>
              <SelectTrigger aria-label={text("element")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="titlePosition">{text("headline")}</SelectItem>
                <SelectItem value="subtitlePosition" disabled={!subtitle}>
                  {text("subtitle")}
                </SelectItem>
                <SelectItem value="imagePosition">{text("imagePosition")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
              X %
              <Input
                aria-label="X %"
                type="number"
                min={0}
                max={100}
                value={Math.round(position.x * 10) / 10}
                onChange={(event) => move(Number(event.target.value), position.y)}
              />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
              Y %
              <Input
                aria-label="Y %"
                type="number"
                min={0}
                max={100}
                value={Math.round(position.y * 10) / 10}
                onChange={(event) => move(position.x, Number(event.target.value))}
              />
            </label>
          </div>
          {(["titleSize", "subtitleSize"] as const).map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-ui-caption">
              {text(key)}
              <Input
                aria-label={text(key)}
                type="number"
                min={key === "titleSize" ? 14 : 10}
                max={key === "titleSize" ? 100 : 60}
                value={key === "titleSize" ? draft.titleSize : (subtitle?.size ?? 22)}
                disabled={key === "subtitleSize" && !subtitle}
                onChange={(event) => {
                  const size = Math.max(
                    key === "titleSize" ? 14 : 10,
                    Math.min(key === "titleSize" ? 100 : 60, Number(event.target.value)),
                  );
                  if (key === "titleSize") change({ ...draft, titleSize: size });
                  else changeSubtitle({ size });
                }}
              />
            </label>
          ))}
          <StartupSubtitleTiming subtitle={subtitle} changeSubtitle={changeSubtitle} />
          <label className="flex min-w-0 flex-col gap-1 text-ui-caption">
            {text("imageScale")}
            <Input
              aria-label={text("imageScale")}
              type="number"
              min={0.5}
              max={2}
              step={0.1}
              value={draft.imageScale}
              onChange={(event) =>
                change({
                  ...draft,
                  imageScale: Math.max(0.5, Math.min(2, Number(event.target.value))),
                })
              }
            />
          </label>
          {(["accent", "background"] as const).map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-ui-caption">
              {text(key)}
              <Input
                aria-label={text(key)}
                type="color"
                value={draft[key]}
                onChange={(event) => change({ ...draft, [key]: event.target.value })}
                className="h-[var(--startup-control-height)] p-1"
              />
            </label>
          ))}
          <div className="flex min-w-0 flex-col gap-1 text-ui-caption">
            {text("easing")}
            {/* 曲线属于缓动字段，不能作为独立网格项掉到左侧下一行。 */}
            <div className="flex min-w-0 items-center gap-2">
              <Select
                value={draft.easing}
                onValueChange={(next: typeof draft.easing) => change({ ...draft, easing: next })}
              >
                <SelectTrigger aria-label={text("easing")} className="min-w-0 flex-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SCENE_EASINGS.map((key) => (
                    <SelectItem key={key} value={key}>
                      {text(key)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <svg
                viewBox="0 0 120 60"
                role="img"
                aria-label={text("curve")}
                className="h-[var(--startup-control-height)] w-28 shrink-0 rounded-md border border-border"
              >
                <polyline
                  points={easingCurve}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
          </div>
        </div>
        <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <legend className="mb-2 text-ui-caption font-medium">{text("durations")}</legend>
          {(Object.keys(draft.durations) as Array<keyof typeof draft.durations>).map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1 text-ui-caption">
              {text(key)}
              <Input
                aria-label={text(key)}
                type="number"
                min={0.3}
                max={6}
                step={0.1}
                value={draft.durations[key]}
                onChange={(event) =>
                  change({
                    ...draft,
                    durations: {
                      ...draft.durations,
                      [key]: Math.max(0.3, Math.min(6, Number(event.target.value))),
                    },
                  })
                }
              />
            </label>
          ))}
        </fieldset>
        <div className="flex flex-wrap items-end gap-2" data-testid="startup-scene-media-controls">
          <label className="flex min-w-0 basis-full flex-col gap-1 text-ui-caption sm:basis-64 sm:flex-1">
            {text("image")}
            <Input
              aria-label={text("image")}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,video/mp4,video/webm"
              disabled={editor.busy}
              className="file:h-auto file:min-h-6"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) void editor.importImage(file);
              }}
            />
          </label>
          {/* 按输入控件底边对齐；换行时整组操作保持间距和顺序。 */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={editor.useBuiltinImage}>
              {text("builtin")}
            </Button>
            <Button variant="outline" size="sm" disabled={editor.busy} onClick={editor.reset}>
              {text("reset")}
            </Button>
            <Button size="sm" disabled={editor.busy} onClick={() => void editor.commit()}>
              {text("save")}
            </Button>
            {value.preset === "baili" ? (
              <Button
                variant="outline"
                size="sm"
                disabled={editor.busy}
                onClick={() => void editor.restoreOriginal()}
              >
                {text("originalBaili")}
              </Button>
            ) : null}
          </div>
        </div>
        {editor.failed ? (
          <p role="alert" className="text-ui-caption text-destructive">
            {text("failed")}
          </p>
        ) : null}
        {editor.saved ? (
          <p role="status" className="text-ui-caption text-foreground-subtle">
            {text("saved")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
