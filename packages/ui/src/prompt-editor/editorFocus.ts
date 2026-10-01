import { SKIP_DOM_SELECTION_TAG, type LexicalEditor } from "lexical";
import { isCoarseTouchDevice } from "@/lib/pickerFocus.js";
import { PROGRAMMATIC_UPDATE_TAG } from "@/lib/editorUpdateTags.js";

/** 显隐由宿主拥有；这里仅在实际执行输入焦点/选区更新时读取 DOM 投影。 */
export function isEditorSurfaceHidden(element: HTMLElement | null): boolean {
  if (
    !element ||
    !element.isConnected ||
    element.closest('[inert], [hidden], [aria-hidden="true"]') ||
    element.getClientRects().length === 0
  )
    return true;
  const view = element.ownerDocument.defaultView;
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    const style = view?.getComputedStyle(current);
    if (style?.visibility === "hidden" || style?.opacity === "0") return true;
  }
  return false;
}

export function getProgrammaticEditorUpdateTags(
  editor: Pick<LexicalEditor, "getRootElement">,
): string[] {
  const root = editor.getRootElement();
  // setText/mention 恢复会 selectEnd；仅关掉 Composer autofocus 仍会由 Lexical DOM 选区唤起键盘。
  // 不聚焦的手机和 inert 表面跳过 DOM 选区，不跳过内容更新，也不 blur 正在主动输入的用户。
  const skipSelection =
    isEditorSurfaceHidden(root) ||
    (isCoarseTouchDevice() && !root?.contains(root.ownerDocument.activeElement));
  return skipSelection
    ? [PROGRAMMATIC_UPDATE_TAG, SKIP_DOM_SELECTION_TAG]
    : [PROGRAMMATIC_UPDATE_TAG];
}

export function focusEditorIfVisible(
  editor: Pick<LexicalEditor, "getRootElement" | "focus">,
): void {
  if (!isEditorSurfaceHidden(editor.getRootElement())) editor.focus();
}
