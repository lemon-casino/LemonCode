import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { cn } from "@/components/lib/utils.js";

const LABEL_ROLL_TRANSITION = {
  duration: 0.2,
  ease: [0.4, 0, 0.2, 1],
} as const;

const LABEL_ROOT_CLASS_NAME =
  "relative inline-flex h-[1.3em] min-w-0 items-center overflow-hidden whitespace-nowrap leading-[1.25]";
const LABEL_CONTENT_CLASS_NAME = "inline-flex min-w-0 whitespace-nowrap leading-[1.25]";

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setPrefersReducedMotion(query.matches);
    };
    update();

    if (typeof query.addEventListener === "function") {
      query.addEventListener("change", update);
      return () => {
        query.removeEventListener("change", update);
      };
    }

    query.addListener(update);
    return () => {
      query.removeListener(update);
    };
  }, []);

  return prefersReducedMotion;
}

export function RollingToolbarLabel({
  label,
  className,
  prefix,
  prefixClassName,
  value,
  reducedMotionOverride,
}: {
  label: string;
  className?: string;
  prefix?: string;
  prefixClassName?: string;
  value?: string;
  /** 供确定性渲染环境覆盖系统媒体查询；生产调用保持未定义。 */
  reducedMotionOverride?: boolean;
}) {
  const prefersReducedMotion = usePrefersReducedMotion();
  const reducedMotion = reducedMotionOverride ?? prefersReducedMotion;
  const content =
    prefix !== undefined && value !== undefined ? (
      <>
        <span className={prefixClassName}>{prefix}</span>
        <span>{value}</span>
      </>
    ) : (
      label
    );

  const rootClassName = cn(LABEL_ROOT_CLASS_NAME, className);

  if (reducedMotion) {
    // 修复依据：旧 reduced-motion 分支比动画分支少一层，Composer 的位置选择器会把
    // provider/model 两段直接设为 block，固定高度按钮因此换行并裁掉 model。两种模式
    // 必须保留同一层级，只让内层是否使用 motion 产生差异。
    return (
      <span className={rootClassName} data-toolbar-label-root="true" title={label}>
        <span className={LABEL_CONTENT_CLASS_NAME} data-toolbar-label-content="true">
          {content}
        </span>
      </span>
    );
  }

  return (
    <span className={rootClassName} data-toolbar-label-root="true" title={label}>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={label}
          className={LABEL_CONTENT_CLASS_NAME}
          data-toolbar-label-content="true"
          initial={{ y: "0.75em", opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: "-0.75em", opacity: 0 }}
          transition={LABEL_ROLL_TRANSITION}
        >
          {content}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
