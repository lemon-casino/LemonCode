export const IAB_INPUT_TARGET_TOKEN_PROPERTY = "__lcodeIabInputTargetToken";

/** 页面虚拟粘贴；此函数源码在目标 page execution context 内执行。 */
export const VIRTUAL_PASTE_PAGE_FUNCTION = `async (options) => {
  const asElement = (candidate) => {
    if (candidate == null || typeof candidate !== "object" || !("ownerDocument" in candidate))
      return null;
    const view = candidate.ownerDocument?.defaultView ?? null;
    return view != null && candidate instanceof view.Element ? candidate : null;
  };
  const elementWindow = (element) => element.ownerDocument.defaultView ?? window;
  const deepestActiveElement = (root) => {
    const active = root.activeElement;
    if (active == null) return null;
    const view = elementWindow(active);
    if (active instanceof view.HTMLElement && active.shadowRoot != null)
      return deepestActiveElement(active.shadowRoot) ?? active;
    if (active instanceof view.HTMLIFrameElement || active instanceof view.HTMLFrameElement) {
      try {
        const frameDocument = active.contentDocument ?? active.contentWindow?.document ?? null;
        if (frameDocument != null) return deepestActiveElement(frameDocument) ?? active;
      } catch {
        return active;
      }
    }
    return active;
  };
  const textForMime = (items, mimeType) =>
    items.flatMap((item) => item.entries).find((entry) => entry.mime_type === mimeType)?.text ?? "";
  const fallbackPaste = (target, html, text, replaceInputValue) => {
    const element = asElement(target);
    if (element == null) return;
    const view = elementWindow(element);
    if (element instanceof view.HTMLTextAreaElement || element instanceof view.HTMLInputElement) {
      if (element.disabled || element.readOnly || text.length === 0) return;
      const setValue = (value) => {
        const prototype = Object.getPrototypeOf(element);
        const prototypeSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
        const ownSetter = Object.getOwnPropertyDescriptor(element, "value")?.set;
        if (prototypeSetter != null && ownSetter !== prototypeSetter) prototypeSetter.call(element, value);
        else element.value = value;
      };
      if (element.selectionStart == null || element.selectionEnd == null) {
        setValue(replaceInputValue ? text : element.value + text);
      } else {
        const start = element.selectionStart ?? element.value.length;
        const end = element.selectionEnd ?? element.value.length;
        try {
          element.setRangeText(text, start, end, "end");
        } catch {
          setValue(replaceInputValue ? text : element.value + text);
        }
      }
      element.dispatchEvent(new view.InputEvent("input", { bubbles: true }));
      return;
    }
    if (
      element instanceof view.HTMLElement &&
      (element.isContentEditable || element.closest("[contenteditable=true]"))
    ) {
      element.focus();
      if (html.length > 0) {
        element.ownerDocument.execCommand("insertHTML", false, html);
        return;
      }
      if (text.length > 0) element.ownerDocument.execCommand("insertText", false, text);
    }
  };

  const target = deepestActiveElement(document) ?? document.body;
  if (options.inputTargetToken != null) {
    const element = asElement(target);
    if ((element ?? null)?.${IAB_INPUT_TARGET_TOKEN_PROPERTY} !== options.inputTargetToken)
      throw new Error("Active element is no longer the expected input target");
  }
  if (options.clipboardItems.length === 0)
    throw new Error("Browser Use virtual clipboard has no data to paste");
  const targetElement = asElement(target);
  const view = targetElement == null ? window : elementWindow(targetElement);
  const plainText = textForMime(options.clipboardItems, "text/plain");
  const richText = options.richTextFallback === true
    ? textForMime(options.clipboardItems, "text/html")
    : "";
  if (typeof view.DataTransfer !== "function" || typeof view.ClipboardEvent !== "function") {
    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);
    return {};
  }
  const dataTransfer = new view.DataTransfer();
  for (const item of options.clipboardItems)
    for (const entry of item.entries)
      if (typeof entry.text === "string") dataTransfer.setData(entry.mime_type, entry.text);
  const pasteEvent = new view.ClipboardEvent("paste", {
    bubbles: true,
    cancelable: true,
    clipboardData: dataTransfer,
    composed: true,
  });
  if (target.dispatchEvent(pasteEvent))
    fallbackPaste(target, richText, plainText, options.replaceInputValue === true);
  return {};
}`;
