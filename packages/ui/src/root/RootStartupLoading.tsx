import type { ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

interface RootStartupLoadingProps {
  label: string;
  children?: ReactNode;
  busy?: boolean;
}

export function RootStartupLoading({ label, children, busy = true }: RootStartupLoadingProps) {
  return (
    <div
      // Web 端全局 html/body/#root 为 Electron 透明背景让路，React 接管后会替换 HTML 启动壳。
      // 这里必须由阻塞态自身承接主题背景，否则远控链接会在 Root 恢复期间继续露出浏览器白底。
      className="flex h-full min-h-dvh flex-col items-center justify-center gap-6 bg-background text-foreground"
      role="status"
      aria-busy={busy}
      aria-label={label}
      data-testid="root-startup-loading"
    >
      <LCodeStartupLogoBadge />
      {children}
    </div>
  );
}

/** 初始化与引导共用品牌图标，保持底色、描边、圆角和标志比例一致。 */
export function LCodeStartupLogoBadge({ animated = true }: { animated?: boolean }) {
  return (
    <div className="relative flex size-24 items-center justify-center rounded-3xl bg-[linear-gradient(180deg,#000000_0%,#151718_100%)] text-[#ffffff] shadow-xl/20 before:pointer-events-none before:absolute before:inset-0 before:rounded-[inherit] before:border before:border-[rgba(255,255,255,0.1)] before:content-['']">
      <LCodeStartupLogo className="h-auto w-14" animated={animated} />
    </div>
  );
}

function LCodeStartupLogo({
  className,
  animated = true,
}: {
  className?: string;
  animated?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1024"
      height="1024"
      viewBox="0 0 1024 1024"
      className={cn("shrink-0", className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="lcode-hub-clip-startup">
          <circle cx="356" cy="696" r="112"/>
        </clipPath>
      </defs>
      <g>
        {animated ? (
          <animate
            attributeName="opacity"
            begin="3s"
            dur="1.8s"
            repeatCount="indefinite"
            values="1;0.4;1"
          />
        ) : null}
        <rect x="32" y="32" width="960" height="960" rx="220" fill="#000000"/>
        <rect x="276" y="160" width="160" height="408" rx="30" fill="#FFD414"/>
        <rect x="484" y="616" width="344" height="160" rx="30" fill="#6CCB43"/>
        <g clipPath="url(#lcode-hub-clip-startup)">
          <circle cx="356" cy="696" r="112" fill="#FFD414"/>
          <path
            d="M438 629 C405 647 378 675 356 696 C346 730 337 765 329 799 A112 112 0 0 0 438 629 Z"
            fill="#6CCB43"
          />
          <path
            d="M438 629 C405 647 378 675 356 696 C346 730 337 765 329 799"
            fill="none" stroke="#FFFFFF" strokeWidth="7"
            strokeLinecap="round" strokeLinejoin="round"
          />
          <g fill="#1EA7E1" stroke="#FFFFFF" strokeWidth="6" strokeLinejoin="round">
            <path d="M356 696 C333 678 319 646 334 614 C360 635 369 668 356 696 Z"/>
            <path d="M356 696 C330 714 295 723 270 705 C295 678 330 677 356 696 Z"/>
            <path d="M356 696 C376 674 411 659 438 676 C421 706 387 713 356 696 Z"/>
            <path d="M356 696 C377 721 381 756 362 783 C338 758 335 722 356 696 Z"/>
          </g>
          <path
            d="M360 688 C377 671 383 648 374 632"
            fill="none" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round"
          />
          <circle cx="373" cy="627" r="7" fill="#FFFFFF"/>
          <circle cx="399" cy="661" r="4" fill="#FFFFFF"/>
        </g>
      </g>
    </svg>
  );
}
