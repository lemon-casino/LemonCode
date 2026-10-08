/** 只在隔离浏览器页面执行，函数会序列化，不能引用 Main 闭包；DOM 类型不扩散到 Node 工程。 */
export function elementInfoRuntime(options: {
  x: number;
  y: number;
  includeNonInteractable?: boolean;
}) {
  // keepNames 会给局部变量函数注入模块级 __name helper；toString 后页面没有该闭包。
  // 对象方法自带名称，保持全部辅助逻辑在注入函数内部，兼容真实生产压缩配置。
  const helpers = {
    cssEscape(value: string): string {
      return globalThis.CSS?.escape?.(value) ?? value.replace(/[^\w-]/g, "\\$&");
    },
    candidatesFor(element: Element): string[] {
      const values: string[] = [];
      if (element.id) values.push(`#${helpers.cssEscape(element.id)}`);
      const testId = element.getAttribute("data-testid");
      if (testId) values.push(`[data-testid=${JSON.stringify(testId)}]`);
      const aria = element.getAttribute("aria-label");
      if (aria) values.push(`[aria-label=${JSON.stringify(aria)}]`);
      values.push(element.tagName.toLowerCase());
      return [...new Set(values)];
    },
    role(element: Element): string | null {
      return (
        element.getAttribute("role") ??
        (element.matches("button,input[type=button],input[type=submit]")
          ? "button"
          : element.matches("a[href]")
            ? "link"
            : element.matches("input:not([type]),input[type=text],textarea")
              ? "textbox"
              : null)
      );
    },
    interactable(element: Element): boolean {
      return Boolean(
        helpers.role(element) ||
        element.matches("input,select,textarea,[tabindex],[contenteditable]"),
      );
    },
  };
  return document
    .elementsFromPoint(options.x, options.y)
    .filter((element) => options.includeNonInteractable || helpers.interactable(element))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      const candidates = helpers.candidatesFor(element);
      const visibleText =
        (element as HTMLElement).innerText?.trim() || (element as HTMLInputElement).value || null;
      const ariaName = element.getAttribute("aria-label") || visibleText;
      return {
        tagName: element.tagName.toLowerCase(),
        role: helpers.role(element),
        visibleText,
        ariaName,
        testId: element.getAttribute("data-testid"),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        preview: element.outerHTML.slice(0, 300),
        selector: { primary: candidates[0] ?? null, candidates },
      };
    });
}

export function overlayRuntime(options: { x: number; y: number; remove?: boolean }): void {
  const id = "__lcode-playwright-element-screenshot-overlay";
  document.getElementById(id)?.remove();
  if (options.remove) return;
  const root = document.createElement("div");
  root.id = id;
  root.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  for (const element of document.elementsFromPoint(options.x, options.y)) {
    const rect = element.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;border:2px solid #ff2d55;box-sizing:border-box`;
    root.append(box);
  }
  const point = document.createElement("div");
  point.style.cssText = `position:absolute;left:${options.x - 4}px;top:${options.y - 4}px;width:8px;height:8px;border-radius:50%;background:#ff2d55`;
  root.append(point);
  document.documentElement.append(root);
}
