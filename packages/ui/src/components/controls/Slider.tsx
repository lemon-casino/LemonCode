import "@mantine/core/styles/Slider.css";
import { Slider as MantineSlider } from "@mantine/core";
import type { ComponentPropsWithoutRef, Ref } from "react";
import { MantineControlsProvider } from "./MantineControlsProvider.js";

/**
 * Mantine Slider 控件适配器（controls 适配层首版对外接口）。
 *
 * 对外接口固定为 value/onChange/min/max/step/disabled/aria-label：
 * - value 受控 number，唯一所有者是调用方 state（如 WhiteboardPane 的 strokeWidth）；
 * - onChange 在拖动过程中连续触发（Mantine useMove → handleChange），等价原生
 *   range 的 onChange→setStrokeWidth(Number(...))；不使用 onChangeEnd 延迟；
 * - label 固定为 null：Thumb 仅在 label != null 时挂载数值浮层（Thumb.mjs
 *   mounted: label != null），不出数值气泡，也不新增刻度/标记等交互。
 *
 * 样式只通过 Mantine 官方按组件 CSS 入口（styles/Slider.css）加载，不引入
 * 全量 styles.css（其 body/* 全局规则会覆盖宿主主题）。Slider.css 依赖的
 * --mantine-* 变量在本组件作用域内映射为仓库语义 token；明暗随
 * MantineControlsProvider 的 forceColorScheme 变化。
 */

// 透传给 Slider 根元素的 DOM 属性。排除与适配器接口冲突及 Mantine 内部
// 接管的键；className 等保留，保证被 ControlHintTooltip / Radix asChild
// cloneElement 合并的事件与类名仍能落到真实 DOM。
type SliderRestProps = Omit<
  ComponentPropsWithoutRef<"div">,
  | "value"
  | "onChange"
  | "min"
  | "max"
  | "step"
  | "disabled"
  | "defaultValue"
  | "aria-label"
  | "role"
  | "children"
  | "style"
  | "ref"
>;

export interface SliderProps extends SliderRestProps {
  /** 受控值；状态所有者是调用方。 */
  value: number;
  /** 拖动过程中连续触发；等价原生 range 的 onChange。 */
  onChange: (value: number) => void;
  /** 必填：不设默认值，避免调用方漏传时静默落入某个业务专用的区间。 */
  min: number;
  /** 必填：同 min。 */
  max: number;
  /** 必填：同 min。 */
  step: number;
  disabled?: boolean;
  /** 可访问名：落到 role="slider" 的滑块元素（Mantine thumbLabel）。 */
  "aria-label"?: string;
  ref?: Ref<HTMLDivElement>;
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step,
  disabled,
  "aria-label": ariaLabel,
  ref,
  ...rest
}: SliderProps) {
  return (
    <MantineControlsProvider>
      <MantineSlider
        {...rest}
        ref={ref}
        value={value}
        onChange={onChange}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        label={null}
        thumbLabel={ariaLabel}
        // 原生 range 为药丸轨道；Mantine 具名 radius 会解析到按组件 CSS 入口
        // 未提供的 --mantine-radius-*，数字值直接转 rem，观感一致。
        radius={9999}
        // 颜色/轨道映射语义 token：填充条与滑块描边用 --color-primary，
        // 不引入 Mantine 默认色板；md 轨道（0.5rem）+ 16px 滑块与原生 thumb 一致。
        color="var(--color-primary)"
        size="md"
        // --mantine-scale 是 Slider.css 全部 calc() 的乘数，默认变量表不随
        // 按组件 CSS 入口提供，必须在组件作用域内补齐；宽度对齐原 w-20。
        style={{
          "--mantine-scale": "1",
          "--mantine-shadow-sm": "var(--shadow-sm, 0 0 #0000)",
          width: "5rem",
        }}
        styles={{
          // 轨道底色覆盖 Mantine 的 scheme 默认（--mantine-color-gray-2/dark-4）；
          // 内联自定义属性由 ::before 继承，两种基底主题统一走语义 token。
          track: {
            "--slider-track-bg": disabled ? "var(--color-surface)" : "var(--color-secondary)",
          },
          thumb: {
            backgroundColor: "var(--color-background)",
            borderColor: "var(--color-primary)",
            color: "var(--color-primary)",
          },
          ...(disabled ? { bar: { backgroundColor: "var(--color-foreground-subtle)" } } : {}),
        }}
      />
    </MantineControlsProvider>
  );
}
