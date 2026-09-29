import appLogoUrl from "@/assets/app-logo.svg";
import { cn } from "@/components/lib/utils.js";

/** 应用徽标：柠檬 L 放大版图标（lemon-l-enlarged-icon-v10），黑色圆角底自带。 */
export function LCodeAboutLogo({ className }: { className?: string }) {
  return <img src={appLogoUrl} alt="" className={cn("shrink-0", className)} draggable={false} />;
}

export function LCodeWordmarkLogo({ className }: { className?: string }) {
  return <img src={appLogoUrl} alt="" className={cn("shrink-0", className)} draggable={false} />;
}
