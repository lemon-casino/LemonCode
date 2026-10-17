import type { ComponentProps, DragEvent } from "react";
import { DialogContent } from "@/components/ui/dialog.js";
import { cn } from "@/components/lib/utils.js";

// 中文依据：项目弹框通过 Portal 挂载，但文件拖拽仍会冒泡到会话祖先和全局输入框监听器；内容与遮罩都要截住。
function isolateFiles(event: DragEvent<HTMLDivElement>) {
  if (!Array.from(event.dataTransfer.types).includes("Files")) return;
  event.preventDefault();
  event.stopPropagation();
}
export function ProjectDialogContent({
  className,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  onEscapeKeyDown,
  ...props
}: ComponentProps<typeof DialogContent>) {
  return (
    <DialogContent
      overlayProps={{
        onDragEnter: isolateFiles,
        onDragOver: isolateFiles,
        onDragLeave: isolateFiles,
        onDrop: isolateFiles,
      }}
      className={cn(
        "flex h-[min(28rem,calc(100dvh-2rem))] max-w-2xl flex-col gap-4 overflow-hidden p-6 max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:max-w-full max-sm:translate-0 max-sm:rounded-none",
        className,
      )}
      onDragEnter={(event) => {
        onDragEnter?.(event);
        isolateFiles(event);
      }}
      onDragOver={(event) => {
        onDragOver?.(event);
        isolateFiles(event);
      }}
      onDragLeave={(event) => {
        onDragLeave?.(event);
        isolateFiles(event);
      }}
      onDrop={(event) => {
        onDrop?.(event);
        isolateFiles(event);
      }}
      onEscapeKeyDown={(event) => {
        // 中文依据：Radix 在 document capture 阶段处理 Escape，先阻止弹框关闭，再由目录行收起输入和还焦。
        if (event.target instanceof Element && event.target.hasAttribute("data-project-purpose")) {
          event.preventDefault();
          return;
        }
        onEscapeKeyDown?.(event);
      }}
      {...props}
    />
  );
}
