import { useCallback, useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { BrainIcon } from "lucide-react";
import {
  testId,
  TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM,
  type LCodeConfigOption,
  type LCodeProvider,
} from "@lcode/shared";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Slider } from "@/components/controls/Slider.js";
import { Button } from "@/components/ui/button.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import {
  isCoarseTouchDevice,
  shouldRestoreChatInputFocusAfterPickerClose,
} from "@/lib/pickerFocus.js";
import { getThoughtLevelLabel, isNoThoughtLevel } from "./thoughtLevelOptions.js";
import { RollingToolbarLabel } from "./RollingToolbarLabel.js";
import "./thoughtLevelSlider.css";

const THUMB_SIZE = 36;

// 独立网格与哈希打散空格、亮度及尺寸，避免原先两个线性取模形成斜线。
const PARTICLES = Array.from({ length: 44 * 6 }, (_, index) => {
  const hash = (Math.imul(index + 1, 1597334677) ^ Math.imul(index + 11, 3812015801)) >>> 0;
  const size = hash % 5 === 0 ? 4 : 3;
  return {
    visible: hash % 100 < 72,
    tone: hash % 3,
    style: {
      left: `${(((index % 44) + 0.5) / 44) * 100}%`,
      top: `${((Math.floor(index / 44) + 0.5) / 6) * 100}%`,
      width: `${size}px`,
      height: `${size}px`,
      opacity: 0.3 + (hash % 65) / 100,
    },
  };
}).filter((particle) => particle.visible);

interface ThoughtLevelSliderPopoverProps {
  children: ReactNode;
  option: LCodeConfigOption;
  provider?: LCodeProvider;
  currentLabel: string;
  tooltipTitle: string;
  shortcutLabel?: string;
  triggerRef: RefObject<HTMLSpanElement | null>;
  intl: IntlInstance;
  disabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onValueChange: (value: string) => void;
  restoreFocusSelector: string | null;
}

export function ThoughtLevelSliderPopover({
  children,
  option,
  provider,
  currentLabel,
  tooltipTitle,
  shortcutLabel,
  triggerRef,
  intl,
  disabled,
  open,
  onOpenChange,
  onValueChange,
  restoreFocusSelector,
}: ThoughtLevelSliderPopoverProps) {
  const entries = option.options ?? [];
  const index = entries.findIndex((entry) => entry.value === option.currentValue);
  const currentEntry = entries[index];
  const maxIndex = Math.max(1, entries.length - 1);
  const thinkingEntries = entries.filter((entry) => !isNoThoughtLevel(entry));
  const strength =
    currentEntry && !isNoThoughtLevel(currentEntry)
      ? (thinkingEntries.indexOf(currentEntry) + 1) / thinkingEntries.length
      : 0;
  const progress = strength > 0 ? (Math.max(0, index) / maxIndex) * 100 : 0;
  const title = intl.formatMessage({ id: "chat.toolbar.thoughtLevel.tooltip" });
  const interactionRef = useRef({ option, disabled, onValueChange });
  interactionRef.current = { option, disabled, onValueChange };
  const selectIndex = useCallback((nextIndex: number) => {
    // Mantine useMove 的窗口监听会在同次拖动中保留起始回调；读取最新受控投影，
    // 避免重复提交末档，也避免拖回起始档时被旧 currentValue 错判为无变化。
    const { option, disabled, onValueChange } = interactionRef.current;
    const entry = option.options?.[nextIndex];
    // 索引仅是目录投影；不允许越界值或重复同档写入 Composer 的模型意图。
    if (!disabled && entry && entry.value !== option.currentValue) onValueChange(entry.value);
  }, []);

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <ControlHintTooltip
        title={tooltipTitle}
        shortcut={shortcutLabel}
        triggerRef={triggerRef}
        open={open ? false : undefined}
      >
        <PopoverTrigger asChild>{children}</PopoverTrigger>
      </ControlHintTooltip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={4}
        collisionPadding={8}
        className="thought-level-panel w-80 gap-2 p-3"
        aria-label={title}
        data-testid="chat-thought-level-slider-panel"
        data-energy={strength > 0 ? "active" : "off"}
        data-peak={strength === 1 ? "true" : "false"}
        style={
          {
            "--thought-level-progress": `${progress}%`,
            "--thought-level-size": `${THUMB_SIZE}px`,
            "--thought-level-pixel-opacity": Math.max(0, (strength - 0.2) / 0.8),
            "--thought-level-flow-duration": `${5 - strength * 3.2}s`,
          } as CSSProperties
        }
        onCloseAutoFocus={(event) => {
          if (!restoreFocusSelector) return;
          event.preventDefault();
          if (
            shouldRestoreChatInputFocusAfterPickerClose({
              isCoarseTouchDevice: isCoarseTouchDevice(),
            })
          ) {
            document.querySelector<HTMLElement>(restoreFocusSelector)?.focus();
          }
        }}
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="text-ui-base text-foreground-subtle">{title}</span>
          <span
            className="min-w-0 max-w-full text-ui-base font-medium text-foreground"
            data-thought-level-current-label
          >
            <RollingToolbarLabel
              label={currentLabel}
              className="max-w-full"
              reserveLabels={entries.map((entry) =>
                getThoughtLevelLabel(intl, provider, option, entry),
              )}
            />
          </span>
        </div>
        <div className="flex justify-between gap-3 text-ui-xs text-foreground-subtle">
          <span>{intl.formatMessage({ id: "chat.toolbar.thoughtLevel.faster" })}</span>
          <span className="text-right">
            {intl.formatMessage({ id: "chat.toolbar.thoughtLevel.deeper" })}
          </span>
        </div>
        <div className="relative">
          {entries.length > 1 ? (
            <Slider
              key={JSON.stringify(entries.map((entry) => entry.value))}
              value={Math.max(0, index)}
              min={0}
              max={entries.length - 1}
              step={1}
              onChange={selectIndex}
              disabled={disabled}
              aria-label={title}
              thumbValueText={currentLabel}
              thumbProps={{ "aria-invalid": index < 0 ? true : undefined }}
              thumbChildren={
                <BrainIcon className="thought-level-brain size-5" aria-hidden="true" />
              }
              thumbSize={THUMB_SIZE}
              size={THUMB_SIZE / 2}
              style={{ width: "100%", height: THUMB_SIZE + 8 }}
              classNames={{
                root: "thought-level-root",
                track: "thought-level-track",
                bar: "thought-level-bar",
                thumb: "thought-level-thumb",
              }}
              styles={{
                bar: {
                  background:
                    "linear-gradient(90deg, color-mix(in srgb, var(--color-brand) 8%, var(--color-surface)), color-mix(in srgb, var(--color-brand) 38%, var(--color-surface)))",
                  opacity: strength > 0 ? 1 : 0,
                },
                thumb: {
                  backgroundColor: "var(--color-popover)",
                  borderColor: "var(--color-popover-border)",
                  color: strength > 0 ? "var(--color-brand)" : "var(--color-foreground-subtle)",
                },
              }}
            />
          ) : null}
          <div className="thought-level-energy" aria-hidden="true">
            <div className="thought-level-energy-fill">
              <div className="thought-level-pixel-belt">
                {[0, 1].map((copy) => (
                  <div key={copy} className="thought-level-pixel-field">
                    {PARTICLES.map(({ style, tone }, particle) => (
                      <span
                        key={particle}
                        className="thought-level-particle"
                        data-tone={tone}
                        style={style}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="thought-level-ticks" aria-hidden="true">
            {entries.map((entry, entryIndex) => (
              <span
                key={entry.value}
                data-selected={entryIndex === index}
                style={{ left: `${(entryIndex / maxIndex) * 100}%` }}
              />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-0.5">
          {entries.map((entry, entryIndex) => (
            <Button
              key={entry.value}
              variant="ghost"
              size="xs"
              disabled={disabled}
              aria-pressed={entryIndex === index}
              className="thought-level-option h-auto min-h-9 whitespace-normal rounded-md px-1.5 py-1 text-ui-xs leading-relaxed text-foreground-subtle aria-pressed:bg-accent aria-pressed:text-foreground"
              data-testid={testId(TID_CHAT_THOUGHT_LEVEL_SELECT_ITEM, entry.value)}
              onClick={() => selectIndex(entryIndex)}
            >
              {getThoughtLevelLabel(intl, provider, option, entry)}
            </Button>
          ))}
        </div>
        <p className="text-ui-xs text-foreground-subtle">
          {intl.formatMessage({ id: "chat.toolbar.thoughtLevel.sliderHint" })}
        </p>
      </PopoverContent>
    </Popover>
  );
}
