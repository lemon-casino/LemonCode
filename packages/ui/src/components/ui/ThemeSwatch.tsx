import {
  CloudSun,
  Flame,
  Monitor,
  Moon,
  Mountain,
  Sparkles,
  Sun,
  Sunset,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/components/lib/utils.js";
import type { ThemeOption } from "@/useTheme.js";

// 这里只定义展示符号；可选主题与色板仍由 themeConfig 的注册表独占。
const THEME_SYMBOLS: Record<ThemeOption["id"], LucideIcon> = {
  system: Monitor,
  dark: Moon,
  light: Sun,
  "zai-dark": Moon,
  "zai-light": Sun,
  "sepia-light": Sunset,
  "midnight-blue": CloudSun,
  "forest-dark": Mountain,
  cinnabar: Flame,
  inkpurple: Sparkles,
};

/** 四个主题入口共用的装饰符号，保留原组件接口，不承载选择状态。 */
export function ThemeSwatch({ option, className }: { option: ThemeOption; className?: string }) {
  const Icon = THEME_SYMBOLS[option.id];
  // 16px 内拼色圆弧与圆点曾挤成不规则色块；使用同一图标库的线性符号保持清晰。
  return (
    <Icon
      aria-hidden="true"
      className={cn("size-4 shrink-0 text-foreground-subtle", className)}
      strokeWidth={1.75}
    />
  );
}
