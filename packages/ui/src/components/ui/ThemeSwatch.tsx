import { cn } from "@/components/lib/utils.js";
import type { ThemeOption } from "@/useTheme.js";

/**
 * 主题三色小色板（底色圆 + 前景色弧 + 主色圆点），纯展示组件。
 * 色值唯一来源是 useTheme.ts 的 THEME_OPTIONS 注册表，不在此处另存一份色板；
 * system（dynamic 基底）没有静态色板，用亮/暗对半分色表达「跟随系统」语义。
 * 设置页 Select 与侧栏主题菜单共用同一份渲染，不发明新的样式体系。
 */
export function ThemeSwatch({
  option,
  className,
}: {
  option: ThemeOption;
  className?: string;
}) {
  if (option.base === "dynamic") {
    return (
      <span
        aria-hidden
        className={cn(
          "relative inline-block size-4 shrink-0 overflow-hidden rounded-full border border-border",
          className,
        )}
      >
        <span
          className="absolute inset-y-0 left-0 w-1/2"
          style={{ backgroundColor: option.swatch.bg }}
        />
        <span
          className="absolute inset-y-0 right-0 w-1/2"
          style={{ backgroundColor: option.swatch.fg }}
        />
      </span>
    );
  }

  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-block size-4 shrink-0 overflow-hidden rounded-full border border-border",
        className,
      )}
      style={{ backgroundColor: option.swatch.bg }}
    >
      {/* 前景色以右上溢出圆弧表达（配合 overflow-hidden 裁出月牙），主色以左下圆点表达。 */}
      <span
        className="absolute -right-1.5 -top-1.5 size-3.5 rounded-full opacity-90"
        style={{ backgroundColor: option.swatch.fg }}
      />
      <span
        className="absolute bottom-0 left-0 size-1.5 rounded-full"
        style={{ backgroundColor: option.swatch.primary }}
      />
    </span>
  );
}
