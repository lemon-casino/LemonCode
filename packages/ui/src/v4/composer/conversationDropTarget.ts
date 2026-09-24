import type { DragEventHandler } from "react";
import type { SessionReferenceDragPayload } from "@/v4/sessionReferenceDragDrop.js";

/**
 * ConversationComposer 暴露给外层对话表面的文件/会话引用 drop 接口。
 *
 * controller 只在 renderer 内路由到既有 composer；不创建第二个上传状态机，
 * 也不改变 desktop continuous / web-remote-replayable 的传输边界。
 */
export interface ConversationDropTargetController {
  active: boolean;
  kind: "attachment" | "workspace" | "session-reference" | null;
  /** session-reference 只有 armed 才显示全屏蒙层；candidate 仅显示目标 ring。 */
  phase?: "candidate" | "armed";
  sessionReferenceTitle?: string;
  onDragOver: DragEventHandler<HTMLElement>;
  onDragLeave: DragEventHandler<HTMLElement>;
  onDrop: DragEventHandler<HTMLElement>;
  /** dnd-kit pointer drag 没有 DataTransfer，沿用同一 controller 接收坐标事件。 */
  onPointerDragMove?: (
    payload: SessionReferenceDragPayload,
    clientX: number,
    clientY: number,
  ) => void;
  onPointerDragLeave?: (payload: SessionReferenceDragPayload) => void;
  onPointerDrop?: (
    payload: SessionReferenceDragPayload,
    clientX: number,
    clientY: number,
  ) => boolean;
}
