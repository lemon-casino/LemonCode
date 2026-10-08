import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

// 这里只拥有布局出口；确认、门禁和执行仍由原控制器持有，移动按钮不能重新挂载执行器。
export const ReviewActionSlotContext = createContext<HTMLElement | null>(null);
export function ReviewActionBar({ children }: { children: ReactNode }) {
  const slot = useContext(ReviewActionSlotContext);
  return slot ? (
    createPortal(children, slot)
  ) : (
    <div className="flex flex-wrap gap-2">{children}</div>
  );
}
