import type {
  BrowserCommandResult,
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@lcode/contracts";
import type { Locator, Page } from "playwright-core";

const DEFAULT_TIMEOUT_MS = 3_000;
type PartialResult = Omit<BrowserCommandResult, "elapsedMs">;

function timeoutMs(value?: number): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  return Math.min(DEFAULT_TIMEOUT_MS, Math.max(1, Math.floor(value)));
}

function locatorFor(page: Page, selector: string): Locator {
  return page.locator(selector);
}

function modifiers(
  values?: BrowserPlaywrightModifier[],
): Array<"Alt" | "Control" | "Meta" | "Shift"> {
  return (values ?? []).map((value) =>
    value === "ControlOrMeta" ? (process.platform === "darwin" ? "Meta" : "Control") : value,
  );
}

export async function evaluatePage(
  page: Page,
  expression: string,
  expressionKind: "string" | "function",
  arg: unknown,
  budgetMs: number,
): Promise<unknown> {
  const client = await page.context().newCDPSession(page);
  try {
    const source =
      expressionKind === "function" ? `(${expression})(${JSON.stringify(arg)})` : expression;
    const raw = (await client.send("Runtime.evaluate", {
      expression: source,
      awaitPromise: true,
      returnByValue: true,
      timeout: budgetMs,
    })) as {
      exceptionDetails?: { exception?: { description?: string }; text?: string };
      result?: { value?: unknown };
    };
    if (raw.exceptionDetails) {
      const message =
        raw.exceptionDetails.exception?.description ??
        raw.exceptionDetails.text ??
        "Playwright evaluate failed";
      throw new Error(`playwright.evaluate failed: ${message}`);
    }
    return raw.result?.value;
  } finally {
    await client.detach().catch(() => undefined);
  }
}

async function runLocatorAction(
  page: Page,
  action: Extract<BrowserPlaywrightAction, { name: "locator" }>,
): Promise<unknown> {
  const locator = locatorFor(page, action.selector);
  const timeout = timeoutMs(action.timeoutMs);
  switch (action.operation) {
    case "allTextContents":
      return await locator.allTextContents();
    case "count":
      return await locator.count();
    case "getAttribute":
      return await locator.getAttribute(action.attribute ?? "", { timeout });
    case "innerText":
      return await locator.innerText({ timeout });
    case "isEnabled":
      return await locator.isEnabled({ timeout });
    case "isVisible":
      return await locator.isVisible();
    case "textContent":
      return await locator.textContent({ timeout });
    case "click":
      await locator.click({
        button: action.button,
        force: action.force,
        modifiers: modifiers(action.modifiers),
        timeout,
      });
      return undefined;
    case "dblclick":
      await locator.dblclick({
        button: action.button,
        force: action.force,
        modifiers: modifiers(action.modifiers),
        timeout,
      });
      return undefined;
    case "fill":
      if (action.replace === false)
        await locator.pressSequentially(String(action.value ?? ""), { timeout });
      else await locator.fill(String(action.value ?? ""), { timeout });
      return undefined;
    case "press":
      await locator.press(String(action.value ?? ""), { timeout });
      return undefined;
    case "selectOption": {
      const selections = (action.selections ?? []).map((selection) =>
        selection.index !== undefined
          ? { index: selection.index }
          : selection.label !== undefined
            ? { label: selection.label }
            : { value: selection.value ?? "" },
      );
      await locator.selectOption(selections, { timeout });
      return undefined;
    }
    case "setChecked":
      await locator.setChecked(action.checked ?? true, { force: action.force, timeout });
      return undefined;
    case "waitFor":
      await locator.waitFor({ state: action.state ?? "visible", timeout });
      return undefined;
    case "downloadMedia":
    case "evaluate":
      throw new Error(`Playwright locator operation '${action.operation}' is unavailable`);
  }
}

export async function executeManagedPlaywrightAction(
  page: Page,
  action: BrowserPlaywrightAction,
): Promise<PartialResult> {
  switch (action.name) {
    case "domSnapshot":
      return {
        ok: true,
        value: await page.locator("html").ariaSnapshot({ timeout: DEFAULT_TIMEOUT_MS }),
      };
    case "elementInfo":
      return {
        ok: true,
        value: await page.evaluate(
          ({ x, y, includeNonInteractable }) =>
            document
              .elementsFromPoint(x, y)
              .filter(
                (element) =>
                  includeNonInteractable ||
                  element.matches("a,button,input,select,textarea,[role],[tabindex]"),
              )
              .map((element) => {
                const rect = element.getBoundingClientRect();
                const text = (
                  (element as HTMLElement).innerText ||
                  element.textContent ||
                  ""
                ).trim();
                return {
                  tagName: element.tagName.toLowerCase(),
                  role: element.getAttribute("role"),
                  visibleText: text || null,
                  ariaName: element.getAttribute("aria-label") || text || null,
                  testId: element.getAttribute("data-testid"),
                  boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  preview: element.outerHTML.slice(0, 300),
                  selector: {
                    primary: element.id ? `#${element.id}` : element.tagName.toLowerCase(),
                    candidates: [],
                  },
                };
              }),
          action,
        ),
      };
    case "elementScreenshot": {
      const markerAttribute = "data-lcode-element-screenshot";
      const count = await page.evaluate(
        ({ x, y, includeNonInteractable, markerAttribute }) => {
          const elements = document
            .elementsFromPoint(x, y)
            .filter(
              (element) =>
                includeNonInteractable ||
                element.matches("a,button,input,select,textarea,[role],[tabindex]"),
            );
          let marked = 0;
          for (const element of elements) {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) continue;
            const marker = document.createElement("div");
            marker.setAttribute(markerAttribute, "");
            Object.assign(marker.style, {
              border: "2px solid #ff2d55",
              boxSizing: "border-box",
              height: `${rect.height}px`,
              left: `${rect.left}px`,
              pointerEvents: "none",
              position: "fixed",
              top: `${rect.top}px`,
              width: `${rect.width}px`,
              zIndex: "2147483647",
            });
            document.documentElement.append(marker);
            marked += 1;
          }
          return marked;
        },
        { ...action, markerAttribute },
      );
      if (count === 0) throw new Error("No matching element was found at the requested point");
      try {
        const image = await page.screenshot({ type: "png" });
        return { ok: true, image: { base64: image.toString("base64"), mimeType: "image/png" } };
      } finally {
        await page
          .evaluate(
            (attribute) =>
              document.querySelectorAll(`[${attribute}]`).forEach((element) => element.remove()),
            markerAttribute,
          )
          .catch(() => undefined);
      }
    }
    case "evaluate":
      return {
        ok: true,
        value: await evaluatePage(
          page,
          action.expression,
          action.expressionKind,
          action.arg,
          timeoutMs(action.timeoutMs),
        ),
      };
    case "waitForLoadState":
      if ((action.state ?? "load") === "networkidle") {
        throw new Error("playwright_wait_for_load_state does not support networkidle");
      }
      await page.waitForLoadState(action.state ?? "load", { timeout: timeoutMs(action.timeoutMs) });
      return { ok: true };
    case "waitForURL":
      if (action.waitUntil === "networkidle") {
        throw new Error("playwright_wait_for_url does not support networkidle");
      }
      await page.waitForURL(action.url, {
        timeout: timeoutMs(action.timeoutMs),
        waitUntil: action.waitUntil ?? "load",
      });
      return { ok: true };
    case "locator": {
      const value = await runLocatorAction(page, action);
      return value === undefined ? { ok: true } : { ok: true, value };
    }
    case "waitForEvent":
    case "downloadPath":
    case "fileChooserSetFiles":
      throw new Error(`Playwright action '${action.name}' is unavailable`);
  }
}
