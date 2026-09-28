/* eslint-disable max-lines -- 与对外暴露的 Playwright 对象图一一对应，集中可避免 builder/终结操作契约漂移。 */
import type {
  BrowserCommand,
  BrowserCommandResult,
  BrowserMouseButton,
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "@lcode/contracts/browser-control";
import { isRegExp } from "node:util/types";
import { base64ToBytes, expectOk } from "./result.js";

type Run = (command: BrowserCommand) => Promise<BrowserCommandResult>;
type ObjectWrapper = <T extends object>(value: T, objectName: string) => T;
const locatorDetails = Symbol("lcode.playwright.locatorDetails");
const setObjectWrapper = Symbol("lcode.playwright.setObjectWrapper");
const publicMembers: Record<string, ReadonlySet<string>> = {
  PlaywrightAPI: new Set([
    "domSnapshot",
    "elementInfo",
    "elementScreenshot",
    "evaluate",
    "expectNavigation",
    "frameLocator",
    "getByLabel",
    "getByPlaceholder",
    "getByRole",
    "getByTestId",
    "getByText",
    "locator",
    "waitForEvent",
    "waitForLoadState",
    "waitForTimeout",
    "waitForURL",
  ]),
  PlaywrightFrameLocator: new Set([
    "frameLocator",
    "getByLabel",
    "getByPlaceholder",
    "getByRole",
    "getByTestId",
    "getByText",
    "locator",
  ]),
  PlaywrightLocator: new Set([
    "all",
    "allTextContents",
    "and",
    "check",
    "click",
    "count",
    "dblclick",
    "downloadMedia",
    "evaluate",
    "fill",
    "filter",
    "first",
    "getAttribute",
    "getByLabel",
    "getByPlaceholder",
    "getByRole",
    "getByTestId",
    "getByText",
    "innerText",
    "isEnabled",
    "isVisible",
    "last",
    "locator",
    "nth",
    "or",
    "press",
    "selectOption",
    "setChecked",
    "textContent",
    "type",
    "uncheck",
    "waitFor",
  ]),
  PlaywrightDownload: new Set(["path"]),
  PlaywrightFileChooser: new Set(["isMultiple", "setFiles"]),
};

const defaultObjectWrapper: ObjectWrapper = <T extends object>(value: T, objectName: string): T =>
  new Proxy(value, {
    get(target, property) {
      if (typeof property === "string" && !publicMembers[objectName]?.has(property)) {
        return undefined;
      }
      const member = Reflect.get(target, property, target);
      return typeof member === "function" ? member.bind(target) : member;
    },
    has(target, property) {
      if (typeof property === "string" && !publicMembers[objectName]?.has(property)) return false;
      return Reflect.has(target, property);
    },
    ownKeys(target) {
      return Reflect.ownKeys(target).filter(
        (property) => typeof property !== "string" || publicMembers[objectName]?.has(property),
      );
    },
  });

export type TextMatcher = string | RegExp;
export type LoadState = "load" | "domcontentloaded" | "networkidle";
export type WaitUntil = LoadState | "commit";
export type WaitForState = "attached" | "detached" | "visible" | "hidden";
export type KeyboardModifier = BrowserPlaywrightModifier;

export interface ElementInfo {
  nodeId?: number | null;
  tagName: string;
  role?: string | null;
  visibleText?: string | null;
  ariaName?: string | null;
  testId?: string | null;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  preview: string;
  selector: { primary?: string | null; candidates: string[]; frameSelectors?: string[] };
}

export type SelectOptionInput = string | { value?: string; label?: string; index?: number };

interface LocatorClickOptions {
  button?: BrowserMouseButton;
  force?: boolean;
  modifiers?: KeyboardModifier[];
  timeoutMs?: number;
}

interface LocatorCheckOptions {
  force?: boolean;
  timeoutMs?: number;
}

interface LocatorFilterOptions {
  has?: PlaywrightLocator;
  hasNot?: PlaywrightLocator;
  hasNotText?: TextMatcher;
  hasText?: TextMatcher;
  visible?: boolean;
}

function playwrightCommand(action: BrowserPlaywrightAction): BrowserCommand {
  return { method: "playwright", action };
}

async function runAction(run: Run, action: BrowserPlaywrightAction): Promise<BrowserCommandResult> {
  const command = playwrightCommand(action);
  return expectOk(command, await run(command));
}

async function runValue<T>(run: Run, action: BrowserPlaywrightAction): Promise<T> {
  return (await runAction(run, action)).value as T;
}

function withContext(error: unknown, context: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new Error(`${message}\n${context}`, { cause: error });
  if (error instanceof Error && error.stack) {
    // 把包含 message 的完整原始 stack 接到新 stack 后，tool result 会把同一个
    // timeout 输出两遍。只继承 stack frames，message 保留一次并通过 cause 保存原始错误。
    const frames = error.stack.split("\n").slice(1).join("\n");
    if (frames) wrapped.stack = `${wrapped.name}: ${wrapped.message}\n${frames}`;
  }
  return wrapped;
}

function serializeMatcher(value: TextMatcher, exact: boolean, method: string): string {
  if (typeof value === "string") {
    const suffix = exact ? "s" : "i";
    return `${JSON.stringify(value)}${suffix}`;
  }
  // node_repl 在独立 VM Realm 中创建 matcher，跨 Realm 正则无法通过 instanceof。
  // 使用 Node 原生类型判定，既支持真实跨 Realm RegExp，也不会被 Symbol.toStringTag 冒充。
  if (isRegExp(value)) return value.toString();
  throw new Error(`${method} requires a string or RegExp`);
}

function roleSelector(role: string, options: { exact?: boolean; name?: TextMatcher }): string {
  if (!role) throw new Error("getByRole requires a role");
  const name =
    options.name === undefined
      ? ""
      : `[name=${serializeMatcher(options.name, Boolean(options.exact), "getByRole")}]`;
  return `internal:role=${role}${name}`;
}

function textSelector(text: TextMatcher, exact: boolean): string {
  return `internal:text=${serializeMatcher(text, exact, "getByText")}`;
}

function labelSelector(text: TextMatcher, exact: boolean): string {
  return `internal:label=${serializeMatcher(text, exact, "getByLabel")}`;
}

function placeholderSelector(text: TextMatcher, exact: boolean): string {
  return `internal:attr=[placeholder=${serializeMatcher(text, exact, "getByPlaceholder")}]`;
}

function testIdSelector(testId: string): string {
  if (!testId) throw new Error("getByTestId requires a testId");
  return `internal:testid=[data-testid=${JSON.stringify(testId)}s]`;
}

function evaluateSource(
  method: "playwright.evaluate" | "locator.evaluate",
  pageFunction: string | ((...args: never[]) => unknown),
): { expression: string; expressionKind: "string" | "function" } {
  if (typeof pageFunction === "string") {
    if (!pageFunction) throw new Error(`${method} requires a pageFunction`);
    return { expression: pageFunction, expressionKind: "string" };
  }
  if (typeof pageFunction === "function") {
    return { expression: pageFunction.toString(), expressionKind: "function" };
  }
  throw new Error(`${method} requires a string or function`);
}

function validateCoordinates(method: string, options: { x: number; y: number }): void {
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y)) {
    throw new Error(`${method} requires numeric x and y coordinates`);
  }
}

function normalizeSelections(input: SelectOptionInput | SelectOptionInput[]) {
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0) throw new Error("locator.selectOption requires at least one value");
  return values.map((selection) => {
    if (typeof selection === "string") return { value: selection };
    if (!selection || typeof selection !== "object") {
      throw new Error("locator.selectOption requires a string or { value?, label?, index? }");
    }
    if (selection.value !== undefined && typeof selection.value !== "string") {
      throw new Error("locator.selectOption value must be a string");
    }
    if (selection.label !== undefined && typeof selection.label !== "string") {
      throw new Error("locator.selectOption label must be a string");
    }
    if (
      selection.index !== undefined &&
      (!Number.isInteger(selection.index) || selection.index < 0)
    ) {
      throw new Error("locator.selectOption index must be a non-negative integer");
    }
    if (
      selection.value === undefined &&
      selection.label === undefined &&
      selection.index === undefined
    ) {
      throw new Error("locator.selectOption requires value, label, or index for each selection");
    }
    return { ...selection };
  });
}

export class PlaywrightLocator {
  constructor(
    private readonly run: Run,
    private readonly owner: object,
    private readonly selector: string,
    private readonly wrap: ObjectWrapper = defaultObjectWrapper,
  ) {}

  private create(selector: string): PlaywrightLocator {
    return this.wrap(
      new PlaywrightLocator(this.run, this.owner, selector, this.wrap),
      "PlaywrightLocator",
    );
  }

  [locatorDetails](): { owner: object; selector: string } {
    return { owner: this.owner, selector: this.selector };
  }

  private action(
    operation: Extract<BrowserPlaywrightAction, { name: "locator" }>["operation"],
    fields: Omit<
      Extract<BrowserPlaywrightAction, { name: "locator" }>,
      "name" | "selector" | "operation"
    > = {},
  ): Promise<BrowserCommandResult> {
    return runAction(this.run, {
      name: "locator",
      selector: this.selector,
      operation,
      ...fields,
    });
  }

  private async value<T>(
    operation: Extract<BrowserPlaywrightAction, { name: "locator" }>["operation"],
    fields: Omit<
      Extract<BrowserPlaywrightAction, { name: "locator" }>,
      "name" | "selector" | "operation"
    > = {},
  ): Promise<T> {
    return (await this.action(operation, fields)).value as T;
  }

  async click(options: LocatorClickOptions = {}): Promise<void> {
    try {
      await this.action("click", options);
    } catch (error) {
      throw withContext(error, `waiting on click for selector ${this.selector}`);
    }
  }

  async dblclick(options: LocatorClickOptions = {}): Promise<void> {
    try {
      await this.action("dblclick", options);
    } catch (error) {
      throw withContext(error, `waiting on dblclick for selector ${this.selector}`);
    }
  }

  async selectOption(
    input: SelectOptionInput | SelectOptionInput[],
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<void> {
    try {
      await this.action("selectOption", { selections: normalizeSelections(input), timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.selectOption failed for selector ${this.selector}`);
    }
  }

  async fill(value: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (value == null) throw new Error("locator.fill requires a value");
    try {
      await this.action("fill", { value, replace: true, timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.fill failed for selector ${this.selector}`);
    }
  }

  async type(value: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (value == null) throw new Error("locator.type requires a value");
    try {
      await this.action("fill", { value, replace: false, timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.type failed for selector ${this.selector}`);
    }
  }

  async press(value: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    if (value == null) throw new Error("locator.press requires a value");
    try {
      await this.action("press", { value, timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.press failed for selector ${this.selector}`);
    }
  }

  async setChecked(checked: boolean, options: LocatorCheckOptions = {}): Promise<void> {
    if (typeof checked !== "boolean") throw new Error("locator.setChecked requires a boolean");
    try {
      await this.action("setChecked", { checked, ...options });
    } catch (error) {
      throw withContext(
        error,
        `locator.setChecked(${checked}) failed for selector ${this.selector}`,
      );
    }
  }

  check(options: LocatorCheckOptions = {}): Promise<void> {
    return this.setChecked(true, options);
  }

  uncheck(options: LocatorCheckOptions = {}): Promise<void> {
    return this.setChecked(false, options);
  }

  async waitFor(options: { state: WaitForState; timeoutMs?: number }): Promise<void> {
    if (!options?.state) throw new Error("locator.waitFor requires a state");
    try {
      await this.action("waitFor", options);
    } catch (error) {
      throw withContext(
        error,
        `locator.waitFor(${options.state}) timed out for selector ${this.selector}`,
      );
    }
  }

  count(): Promise<number> {
    return this.value<number>("count");
  }

  async all(): Promise<PlaywrightLocator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_unused, index) => this.nth(index));
  }

  textContent({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string | null> {
    return this.value("textContent", { timeoutMs });
  }

  innerText({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string> {
    return this.value("innerText", { timeoutMs });
  }

  getAttribute(name: string, { timeoutMs }: { timeoutMs?: number } = {}): Promise<string | null> {
    if (!name) throw new Error("locator.getAttribute requires a name");
    return this.value("getAttribute", { attribute: name, timeoutMs });
  }

  isVisible(): Promise<boolean> {
    return this.value("isVisible");
  }

  isEnabled(): Promise<boolean> {
    return this.value("isEnabled");
  }

  allTextContents({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string[]> {
    return this.value("allTextContents", { timeoutMs });
  }

  evaluate<TResult, TArg = unknown>(
    pageFunction: string | ((element: Element, arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg,
    options?: { timeoutMs?: number },
  ): Promise<TResult> {
    return this.value("evaluate", {
      ...evaluateSource("locator.evaluate", pageFunction as never),
      arg,
      timeoutMs: options?.timeoutMs,
    });
  }

  async downloadMedia({ timeoutMs }: { timeoutMs?: number } = {}): Promise<void> {
    try {
      await this.action("downloadMedia", { timeoutMs });
    } catch (error) {
      throw withContext(error, `locator.downloadMedia failed for selector ${this.selector}`);
    }
  }

  locator(
    selector: string,
    options: Omit<LocatorFilterOptions, "visible"> = {},
  ): PlaywrightLocator {
    if (!selector) throw new Error("locator.locator requires a selector");
    return this.create(`${this.selector} >> ${selector}`).filter(options);
  }

  first(): PlaywrightLocator {
    return this.create(`${this.selector} >> nth=0`);
  }

  last(): PlaywrightLocator {
    return this.create(`${this.selector} >> nth=-1`);
  }

  nth(index: number): PlaywrightLocator {
    if (typeof index !== "number") throw new Error("locator.nth requires a numeric index");
    return this.create(`${this.selector} >> nth=${index}`);
  }

  and(locator: PlaywrightLocator): PlaywrightLocator {
    const selector = this.compatibleSelector(locator, "locator.and");
    return this.create(`${this.selector} >> internal:and=${JSON.stringify(selector)}`);
  }

  or(locator: PlaywrightLocator): PlaywrightLocator {
    const selector = this.compatibleSelector(locator, "locator.or");
    return this.create(`${this.selector} >> internal:or=${JSON.stringify(selector)}`);
  }

  filter(options: LocatorFilterOptions = {}): PlaywrightLocator {
    const selectors = [this.selector];
    if (options.hasText !== undefined) {
      selectors.push(
        `internal:has-text=${serializeMatcher(options.hasText, false, "locator.filter")}`,
      );
    }
    if (options.hasNotText !== undefined) {
      selectors.push(
        `internal:has-not-text=${serializeMatcher(options.hasNotText, false, "locator.filter")}`,
      );
    }
    if (options.has !== undefined) {
      const selector = this.compatibleSelector(options.has, "locator.filter has");
      selectors.push(`internal:has=${JSON.stringify(selector)}`);
    }
    if (options.hasNot !== undefined) {
      const selector = this.compatibleSelector(options.hasNot, "locator.filter hasNot");
      selectors.push(`internal:has-not=${JSON.stringify(selector)}`);
    }
    if (options.visible !== undefined) {
      if (typeof options.visible !== "boolean") {
        throw new Error("locator.filter visible must be a boolean");
      }
      selectors.push(`visible=${options.visible}`);
    }
    return this.create(selectors.join(" >> "));
  }

  getByRole(
    role: string,
    options: { exact?: boolean; name?: TextMatcher } = {},
  ): PlaywrightLocator {
    return this.child(roleSelector(role, options));
  }

  getByText(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.child(textSelector(text, Boolean(options.exact)));
  }

  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.child(labelSelector(text, Boolean(options.exact)));
  }

  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.child(placeholderSelector(text, Boolean(options.exact)));
  }

  getByTestId(testId: string): PlaywrightLocator {
    return this.child(testIdSelector(testId));
  }

  private child(selector: string): PlaywrightLocator {
    return this.create(`${this.selector} >> ${selector}`);
  }

  private compatibleSelector(locator: PlaywrightLocator, method: string): string {
    if (!(locator instanceof PlaywrightLocator)) {
      throw new Error(`${method} requires a PlaywrightLocator`);
    }
    const details = locator[locatorDetails]();
    if (details.owner !== this.owner) throw new Error("Locators must belong to the same tab");
    return details.selector;
  }
}

export class PlaywrightFrameLocator {
  constructor(
    private readonly run: Run,
    private readonly owner: object,
    private readonly frameSelector: string,
    private readonly wrap: ObjectWrapper = defaultObjectWrapper,
  ) {}

  locator(selector: string): PlaywrightLocator {
    if (!selector) throw new Error("frameLocator.locator requires a selector");
    return this.wrap(
      new PlaywrightLocator(
        this.run,
        this.owner,
        `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`,
        this.wrap,
      ),
      "PlaywrightLocator",
    );
  }

  frameLocator(selector: string): PlaywrightFrameLocator {
    if (!selector) throw new Error("frameLocator.frameLocator requires a selector");
    return this.wrap(
      new PlaywrightFrameLocator(
        this.run,
        this.owner,
        `${this.frameSelector} >> internal:control=enter-frame >> ${selector}`,
        this.wrap,
      ),
      "PlaywrightFrameLocator",
    );
  }

  getByRole(
    role: string,
    options: { exact?: boolean; name?: TextMatcher } = {},
  ): PlaywrightLocator {
    return this.locator(roleSelector(role, options));
  }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(textSelector(text, Boolean(options.exact)));
  }
  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(labelSelector(text, Boolean(options.exact)));
  }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(placeholderSelector(text, Boolean(options.exact)));
  }
  getByTestId(testId: string): PlaywrightLocator {
    return this.locator(testIdSelector(testId));
  }
}

export class PlaywrightDownload {
  constructor(
    private readonly run: Run,
    private readonly downloadId: string,
  ) {}

  path({ timeoutMs }: { timeoutMs?: number } = {}): Promise<string | null> {
    return runValue(this.run, { name: "downloadPath", downloadId: this.downloadId, timeoutMs });
  }
}

export class PlaywrightFileChooser {
  constructor(
    private readonly run: Run,
    private readonly fileChooserId: string,
    private readonly multiple: boolean,
  ) {}

  isMultiple(): boolean {
    return this.multiple;
  }

  async setFiles(
    files: string | string[],
    { timeoutMs }: { timeoutMs?: number } = {},
  ): Promise<void> {
    if (files == null) throw new Error("fileChooser.setFiles requires files");
    const normalized = Array.isArray(files) ? files : [files];
    if (normalized.length === 0) throw new Error("fileChooser.setFiles requires at least one file");
    try {
      await runAction(this.run, {
        name: "fileChooserSetFiles",
        fileChooserId: this.fileChooserId,
        files: normalized,
        timeoutMs,
      });
    } catch (error) {
      throw withContext(error, "fileChooser.setFiles failed");
    }
  }
}

export class PlaywrightAPI {
  private readonly owner = {};
  private wrap: ObjectWrapper = defaultObjectWrapper;

  constructor(private readonly run: Run) {}

  [setObjectWrapper](wrap: ObjectWrapper): void {
    this.wrap = wrap;
  }

  evaluate<TResult, TArg = unknown>(
    pageFunction: string | ((arg: TArg) => TResult | Promise<TResult>),
    arg?: TArg,
    options?: { timeoutMs?: number },
  ): Promise<TResult> {
    return runValue(this.run, {
      name: "evaluate",
      ...evaluateSource("playwright.evaluate", pageFunction as never),
      arg,
      timeoutMs: options?.timeoutMs,
    });
  }

  locator(selector: string): PlaywrightLocator {
    if (!selector) throw new Error("playwright.locator requires a selector");
    return this.wrap(
      new PlaywrightLocator(this.run, this.owner, selector, this.wrap),
      "PlaywrightLocator",
    );
  }
  getByRole(
    role: string,
    options: { exact?: boolean; name?: TextMatcher } = {},
  ): PlaywrightLocator {
    return this.locator(roleSelector(role, options));
  }
  getByText(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(textSelector(text, Boolean(options.exact)));
  }
  getByLabel(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(labelSelector(text, Boolean(options.exact)));
  }
  getByPlaceholder(text: TextMatcher, options: { exact?: boolean } = {}): PlaywrightLocator {
    return this.locator(placeholderSelector(text, Boolean(options.exact)));
  }
  getByTestId(testId: string): PlaywrightLocator {
    return this.locator(testIdSelector(testId));
  }
  frameLocator(selector: string): PlaywrightFrameLocator {
    if (!selector) throw new Error("playwright.frameLocator requires a selector");
    return this.wrap(
      new PlaywrightFrameLocator(this.run, this.owner, selector, this.wrap),
      "PlaywrightFrameLocator",
    );
  }

  async waitForURL(
    url: string,
    options: { timeoutMs?: number; waitUntil?: WaitUntil } = {},
  ): Promise<void> {
    if (!url) throw new Error("playwright.waitForURL requires a url");
    await runAction(this.run, { name: "waitForURL", url, ...options });
  }

  async waitForLoadState(options: { state?: LoadState; timeoutMs?: number } = {}): Promise<void> {
    await runAction(this.run, { name: "waitForLoadState", ...options });
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
      throw new Error("playwright.waitForTimeout requires a non-negative integer");
    }
    const command: BrowserCommand = { method: "playwrightWaitForTimeout", timeoutMs };
    expectOk(command, await this.run(command));
  }

  async waitForEvent(
    event: "download",
    options?: { timeoutMs?: number },
  ): Promise<PlaywrightDownload>;
  async waitForEvent(
    event: "filechooser",
    options?: { timeoutMs?: number },
  ): Promise<PlaywrightFileChooser>;
  async waitForEvent(
    event: "download" | "filechooser",
    options: { timeoutMs?: number } = {},
  ): Promise<PlaywrightDownload | PlaywrightFileChooser> {
    if (event !== "download" && event !== "filechooser") {
      throw new Error("playwright.waitForEvent only supports 'download' and 'filechooser'");
    }
    const value = await runValue<{ id: string; isMultiple?: boolean }>(this.run, {
      name: "waitForEvent",
      event,
      timeoutMs: options.timeoutMs,
    });
    return event === "download"
      ? this.wrap(new PlaywrightDownload(this.run, value.id), "PlaywrightDownload")
      : this.wrap(
          new PlaywrightFileChooser(this.run, value.id, Boolean(value.isMultiple)),
          "PlaywrightFileChooser",
        );
  }

  async expectNavigation<T>(
    action: () => Promise<T>,
    options: { timeoutMs?: number; url?: string; waitUntil?: LoadState } = {},
  ): Promise<T> {
    const wait = options.url
      ? this.waitForURL(options.url, {
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.waitUntil === undefined ? {} : { waitUntil: options.waitUntil }),
        })
      : this.waitForLoadState({
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.waitUntil === undefined ? {} : { state: options.waitUntil }),
        });
    const result = action();
    const [actionResult] = await Promise.all([result, wait]);
    return actionResult;
  }

  elementInfo(options: {
    x: number;
    y: number;
    includeNonInteractable?: boolean;
  }): Promise<ElementInfo[]> {
    validateCoordinates("playwright.elementInfo", options);
    return runValue(this.run, { name: "elementInfo", ...options });
  }

  async elementScreenshot(options: {
    x: number;
    y: number;
    includeNonInteractable?: boolean;
  }): Promise<Uint8Array> {
    validateCoordinates("playwright.elementScreenshot", options);
    const result = await runAction(this.run, { name: "elementScreenshot", ...options });
    if (!result.image) throw new Error("Browser result missing image");
    return base64ToBytes(result.image.base64);
  }

  domSnapshot(): Promise<string> {
    return runValue(this.run, { name: "domSnapshot" });
  }
}

export function createPlaywrightAPI(run: Run): PlaywrightAPI {
  return defaultObjectWrapper(new PlaywrightAPI(run), "PlaywrightAPI");
}

export function configurePlaywrightObjectWrapper(
  api: PlaywrightAPI,
  wrap: ObjectWrapper,
): PlaywrightAPI {
  api[setObjectWrapper](wrap);
  return wrap(api, "PlaywrightAPI");
}
