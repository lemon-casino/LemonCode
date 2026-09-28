import type { BrowserSnapshot } from "@lcode/contracts";
import type { ElementHandle, Page } from "playwright-core";

const DEFAULT_MAX_ELEMENTS = 200;
const DEFAULT_MAX_DOM_NODES = 300;

type SnapshotOptions = { includeHidden: boolean; maxDomNodes: number; maxElements: number };
type SnapshotCollection = { refElements: Element[]; snapshot: BrowserSnapshot };

const pageRefs = new WeakMap<Page, Map<string, ElementHandle<Element>>>();

/**
 * 这段函数由 Playwright 序列化到页面执行，不能引用模块闭包。Element ref 不写入页面
 * globalThis，而由 adapter 从返回的 handle collection 接管，避免不可信页面脚本替换 ref map。
 */
function collectSnapshot(options: SnapshotOptions): SnapshotCollection {
  const actionSelector =
    "a[href],button,input,textarea,select,[role],[onclick],[tabindex],summary,label,[contenteditable]";
  const domSelector =
    "body,main,nav,header,footer,aside,section,article,h1,h2,h3,h4,h5,h6,p,ul,ol,li,dl,dt,dd,blockquote,pre,code,table,caption,thead,tbody,tfoot,tr,th,td,form,fieldset,legend,figure,figcaption,img,canvas,svg,a[href],button,input,textarea,select,option,summary,label,[role],[aria-label],[contenteditable]";
  const refElements: Element[] = [];
  const reverseRefs = new WeakMap<Element, string>();
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;

  const hidden = (element: Element): boolean => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0" ||
      (rect.width <= 0 && rect.height <= 0)
    );
  };
  const text = (value: string | null | undefined, max: number): string =>
    String(value ?? "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, max);
  const implicitRole = (element: Element, tag: string): string => {
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag !== "input") return "";
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "submit", "reset"].includes(type)) return "button";
    if (type === "search") return "searchbox";
    return "textbox";
  };
  const accessibleName = (element: Element): string =>
    text(
      element.getAttribute("aria-label") ||
        element.getAttribute("alt") ||
        element.getAttribute("title") ||
        element.getAttribute("placeholder") ||
        (element as HTMLElement).innerText ||
        element.textContent,
      120,
    );
  const attributes = (element: Element): Record<string, string> => {
    const result: Record<string, string> = {};
    for (const key of [
      "id",
      "href",
      "name",
      "type",
      "placeholder",
      "title",
      "alt",
      "role",
      "aria-label",
      "data-testid",
      "data-test",
      "data-qa",
    ]) {
      const value = text(element.getAttribute(key), 240);
      if (value) result[key] = value;
    }
    return result;
  };
  const selector = (element: Element): string => {
    if (element.id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(element.id)) return `#${element.id}`;
    const parts: string[] = [];
    let current: Element | null = element;
    for (let depth = 0; current && depth < 6; depth += 1) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (candidate) => candidate.tagName === current?.tagName,
          )
        : [];
      parts.unshift(`${tag}:nth-of-type(${siblings.indexOf(current) + 1})`);
      current = current.parentElement;
    }
    return parts.join(" > ");
  };
  const xpath = (element: Element): string => {
    const parts: string[] = [];
    let current: Element | null = element;
    while (current) {
      const tag = current.tagName.toLowerCase();
      const siblings = current.parentElement
        ? [...current.parentElement.children].filter(
            (candidate) => candidate.tagName === current?.tagName,
          )
        : [];
      parts.unshift(`${tag}[${siblings.indexOf(current) + 1}]`);
      current = current.parentElement;
    }
    return `/${parts.join("/")}`;
  };
  const inViewport = (rect: DOMRect): boolean =>
    rect.top < viewportHeight && rect.bottom > 0 && rect.left < viewportWidth && rect.right > 0;

  const actionNodes = [...document.querySelectorAll(actionSelector)].filter(
    (element) => options.includeHidden || !hidden(element),
  );
  const elements = actionNodes.slice(0, options.maxElements).map((element, index) => {
    const ref = `e${index + 1}`;
    refElements.push(element);
    reverseRefs.set(element, ref);
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element, tag);
    const name = accessibleName(element);
    const elementText = text((element as HTMLElement).innerText, 100);
    const attrs = attributes(element);
    const value = "value" in element ? text(String((element as HTMLInputElement).value), 240) : "";
    let parent = element.parentElement;
    let parentRef: string | undefined;
    while (parent && !parentRef) {
      parentRef = reverseRefs.get(parent);
      parent = parent.parentElement;
    }
    return {
      ref,
      tag,
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(elementText ? { text: elementText } : {}),
      ...(value ? { value } : {}),
      ...("disabled" in element && (element as HTMLInputElement).disabled
        ? { disabled: true }
        : {}),
      ...("checked" in element ? { checked: Boolean((element as HTMLInputElement).checked) } : {}),
      selector: selector(element),
      xpath: xpath(element),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      inViewport: inViewport(rect),
      ...(parentRef ? { parentRef } : {}),
      ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    };
  });

  const domNodes = [...document.querySelectorAll(domSelector)].filter(
    (element) => options.includeHidden || !hidden(element),
  );
  const dom = domNodes.slice(0, options.maxDomNodes).map((element) => {
    const rect = element.getBoundingClientRect();
    const tag = element.tagName.toLowerCase();
    const role = element.getAttribute("role") || implicitRole(element, tag);
    const name = accessibleName(element);
    const semanticText =
      /^(h[1-6]|p|li|dt|dd|blockquote|pre|code|caption|th|td|label|summary|button|a|option|legend|figcaption)$/.test(
        tag,
      )
        ? text((element as HTMLElement).innerText || element.textContent, 300)
        : "";
    let depth = 0;
    for (
      let parent = element.parentElement;
      parent && parent !== document.body;
      parent = parent.parentElement
    )
      depth += 1;
    const ref = reverseRefs.get(element);
    const attrs = attributes(element);
    return {
      tag,
      depth,
      inViewport: inViewport(rect),
      ...(ref ? { ref } : {}),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(semanticText ? { text: semanticText } : {}),
      ...(Object.keys(attrs).length > 0 ? { attributes: attrs } : {}),
    };
  });

  return {
    refElements,
    snapshot: {
      url: location.href,
      title: document.title,
      elements,
      truncated: actionNodes.length > options.maxElements,
      dom,
      domTruncated: domNodes.length > options.maxDomNodes,
    },
  };
}

export async function captureManagedCdpSnapshot(
  page: Page,
  maxElements = DEFAULT_MAX_ELEMENTS,
  includeHidden = false,
): Promise<BrowserSnapshot> {
  const collection = await page.evaluateHandle(collectSnapshot, {
    includeHidden,
    maxDomNodes: DEFAULT_MAX_DOM_NODES,
    maxElements: Math.max(1, Math.floor(maxElements)),
  });
  const snapshotHandle = await collection.getProperty("snapshot");
  const refElementsHandle = await collection.getProperty("refElements");
  const snapshot = (await snapshotHandle.jsonValue()) as BrowserSnapshot;
  const nextRefs = new Map<string, ElementHandle<Element>>();
  for (const [index, handle] of await refElementsHandle.getProperties()) {
    const element = handle.asElement() as ElementHandle<Element> | null;
    if (!element || !/^\d+$/u.test(index)) {
      await handle.dispose();
      continue;
    }
    nextRefs.set(`e${Number(index) + 1}`, element);
  }
  const previousRefs = pageRefs.get(page);
  pageRefs.set(page, nextRefs);
  await Promise.all([...(previousRefs?.values() ?? [])].map(async (handle) => handle.dispose()));
  await Promise.all([snapshotHandle.dispose(), refElementsHandle.dispose(), collection.dispose()]);
  return snapshot;
}

export async function resolveSnapshotElement(
  page: Page,
  ref: string,
): Promise<ElementHandle<Element> | undefined> {
  const element = pageRefs.get(page)?.get(ref);
  if (!element) return undefined;
  const connected = await element.evaluate((node) => node.isConnected).catch(() => false);
  return connected ? element : undefined;
}

export async function resolveSnapshotRef(
  page: Page,
  ref: string,
): Promise<{ x: number; y: number } | undefined> {
  const element = await resolveSnapshotElement(page, ref);
  if (!element) return undefined;
  await element.scrollIntoViewIfNeeded();
  const rect = await element.boundingBox();
  return rect
    ? { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    : undefined;
}
