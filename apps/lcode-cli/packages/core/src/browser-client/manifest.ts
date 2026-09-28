/* eslint-disable max-lines -- public API manifest、动态裁剪策略和 Proxy 合同集中维护，拆分会增加对象图漂移风险。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  BrowserBackendDescriptor,
  BrowserBackendType,
} from "@lcode/contracts/browser-control";

export type BrowserApiMemberKind = "method" | "property";

export interface BrowserApiManifestMember {
  name: string;
  kind: BrowserApiMemberKind;
  signature: string;
  command?: string;
  documented?: boolean;
  unsupportedByDefaultIn?: BrowserBackendType[];
  requiresCapabilities?: string[];
  declarations?: Array<{
    signature: string;
    documented?: boolean;
    unsupportedByDefaultIn?: BrowserBackendType[];
    requiresCapabilities?: string[];
  }>;
}

export interface BrowserApiManifestObject {
  members: BrowserApiManifestMember[];
}

export interface BrowserApiManifest {
  version: number;
  entrypoints?: string[];
  semantics?: Record<string, string>;
  types?: Record<string, string>;
  objects: Record<string, BrowserApiManifestObject>;
}

const FALLBACK_MANIFEST: BrowserApiManifest = {
  version: 10,
  types: {
    BrowserViewportSize: "{ width: number; height: number }",
    TabInfo:
      "{ id: string; active?: boolean; title?: string; url?: string; viewport: BrowserViewportSize }",
  },
  objects: {
    Agent: {
      members: [
        { name: "browsers", kind: "property", signature: "browsers: Browsers" },
        { name: "documentation", kind: "property", signature: "documentation: Documentation" },
      ],
    },
    Documentation: {
      members: [{ name: "get", kind: "method", signature: "get(name: string): Promise<string>" }],
    },
    Browsers: {
      members: [
        ...["list", "get", "getDefault", "getForUrl"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(...)`,
        })),
        // open() 是默认导航入口（同站复用 + 激活 + 原地跳转）；不声明会被 hideUnknown
        // 代理隐藏，REPL 里 agent.browsers.open 变 undefined（与插件 docs/api.json 同步维护）。
        {
          name: "open",
          kind: "method" as const,
          signature: "open(url?: string, options?: { reuseTab?: boolean }): Promise<Tab>",
        },
      ],
    },
    Browser: {
      members: [
        { name: "browserId", kind: "property", signature: "browserId: string" },
        {
          name: "capabilities",
          kind: "property",
          signature: "capabilities: BrowserCapabilityCollection",
        },
        {
          name: "documentation",
          kind: "method",
          signature: "documentation(): Promise<string>",
        },
        { name: "tabs", kind: "property", signature: "tabs: Tabs" },
        { name: "user", kind: "property", signature: "user: BrowserUser" },
      ],
    },
    BrowserUser: {
      members: [
        {
          name: "claimTab",
          kind: "method",
          signature: "claimTab(tab): Promise<Tab>",
          unsupportedByDefaultIn: ["iab", "cdp"],
        },
        {
          name: "history",
          kind: "method",
          signature: "history(options): Promise<BrowserHistoryEntry[]>",
          unsupportedByDefaultIn: ["iab"],
        },
        {
          name: "openTabs",
          kind: "method",
          signature: "openTabs(): Promise<BrowserUserTabInfo[]>",
        },
      ],
    },
    Tabs: {
      members: [
        ...["get", "new", "selected"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(...)`,
        })),
        {
          name: "list",
          kind: "method" as const,
          signature: "list(): Promise<TabInfo[]>",
        },
        {
          name: "finalize",
          kind: "method" as const,
          signature: "finalize(options): Promise<void>",
          unsupportedByDefaultIn: ["iab", "cdp"] as BrowserBackendType[],
        },
      ],
    },
    Tab: {
      members: [
        { name: "id", kind: "property", signature: "id: string" },
        {
          name: "capabilities",
          kind: "property",
          signature: "capabilities: TabCapabilityCollection",
        },
        ...[
          "back",
          "close",
          "forward",
          "getJsDialog",
          "goto",
          "reload",
          "screenshot",
          "title",
          "url",
        ].map((name) => ({ name, kind: "method" as const, signature: `${name}(...)` })),
        {
          name: "finalize",
          kind: "method",
          signature: "finalize(options?): Promise<void>",
          unsupportedByDefaultIn: ["iab", "cdp"],
        },
        ...["markDeliverable", "markHandoff"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(): Promise<void>`,
          unsupportedByDefaultIn: ["iab", "cdp"] as BrowserBackendType[],
        })),
        { name: "cua", kind: "property", signature: "cua: CUAAPI" },
        { name: "dom_cua", kind: "property", signature: "dom_cua: DomCUAAPI" },
        {
          name: "playwright",
          kind: "property",
          signature: "playwright: PlaywrightAPI",
        },
        {
          name: "recording",
          kind: "property",
          signature: "recording: BrowserRecordingAPI",
        },
        {
          name: "setViewportSize",
          kind: "method",
          signature:
            "setViewportSize(viewportSize: { width: number; height: number }): Promise<void>",
          command: "browserViewportSet",
        },
        {
          name: "viewportSize",
          kind: "method",
          signature: "viewportSize(): { width: number; height: number } | null",
        },
      ],
    },
    BrowserRecordingAPI: {
      members: [
        {
          name: "start",
          kind: "method",
          signature: "start(options?): Promise<BrowserRecordingJob>",
          command: "recordingStart",
          unsupportedByDefaultIn: ["extension", "cdp"],
        },
        {
          name: "status",
          kind: "method",
          signature: "status(recordingId, options?): Promise<BrowserRecordingJob>",
          command: "recordingStatus",
          unsupportedByDefaultIn: ["extension", "cdp"],
        },
        {
          name: "cancel",
          kind: "method",
          signature: "cancel(recordingId): Promise<BrowserRecordingJob>",
          command: "recordingCancel",
          unsupportedByDefaultIn: ["extension", "cdp"],
        },
      ],
    },
    BrowserCapabilityCollection: {
      members: ["get", "list"].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...)`,
      })),
    },
    TabCapabilityCollection: {
      members: ["get", "list"].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...)`,
      })),
    },
    PlaywrightAPI: {
      members: [
        {
          name: "domSnapshot",
          kind: "method",
          signature: "domSnapshot(): Promise<string>",
          command: "playwright",
        },
        {
          name: "elementInfo",
          kind: "method",
          signature: "elementInfo(options: ElementInfoOptions): Promise<ElementInfo[]>",
          command: "playwright",
          documented: false,
        },
        {
          name: "elementScreenshot",
          kind: "method",
          signature: "elementScreenshot(options: ElementScreenshotOptions): Promise<Uint8Array>",
          command: "playwright",
          documented: false,
        },
        {
          name: "evaluate",
          kind: "method",
          signature: "evaluate(pageFunction, arg?, options?): Promise<TResult>",
          command: "playwright",
        },
        {
          name: "expectNavigation",
          kind: "method",
          signature: "expectNavigation(action, options?): Promise<T>",
          command: "playwright",
        },
        {
          name: "frameLocator",
          kind: "method",
          signature: "frameLocator(selector: string): PlaywrightFrameLocator",
        },
        {
          name: "getByLabel",
          kind: "method",
          signature: "getByLabel(text, options?): PlaywrightLocator",
        },
        {
          name: "getByPlaceholder",
          kind: "method",
          signature: "getByPlaceholder(text, options?): PlaywrightLocator",
        },
        {
          name: "getByRole",
          kind: "method",
          signature: "getByRole(role, options?): PlaywrightLocator",
        },
        {
          name: "getByTestId",
          kind: "method",
          signature: "getByTestId(testId: string): PlaywrightLocator",
        },
        {
          name: "getByText",
          kind: "method",
          signature: "getByText(text, options?): PlaywrightLocator",
        },
        {
          name: "locator",
          kind: "method",
          signature: "locator(selector: string): PlaywrightLocator",
        },
        {
          name: "waitForEvent",
          kind: "method",
          signature: "waitForEvent(event, options?): Promise<PlaywrightDownload>",
          command: "playwright",
          declarations: [
            {
              signature: 'waitForEvent(event: "download", options?): Promise<PlaywrightDownload>',
            },
            {
              signature:
                'waitForEvent(event: "filechooser", options?): Promise<PlaywrightFileChooser>',
              unsupportedByDefaultIn: ["iab"],
            },
          ],
        },
        {
          name: "waitForLoadState",
          kind: "method",
          signature: "waitForLoadState(options?): Promise<void>",
          command: "playwright",
        },
        {
          name: "waitForTimeout",
          kind: "method",
          signature: "waitForTimeout(timeoutMs: number): Promise<void>",
          command: "playwrightWaitForTimeout",
        },
        {
          name: "waitForURL",
          kind: "method",
          signature: "waitForURL(url: string, options?): Promise<void>",
          command: "playwright",
        },
      ],
    },
    PlaywrightFrameLocator: {
      members: [
        "frameLocator",
        "getByLabel",
        "getByPlaceholder",
        "getByRole",
        "getByTestId",
        "getByText",
        "locator",
      ].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...): PlaywrightLocator`,
      })),
    },
    PlaywrightLocator: {
      members: [
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
      ].map((name) => ({
        name,
        kind: "method" as const,
        signature: `${name}(...)`,
        command: [
          "all",
          "and",
          "filter",
          "first",
          "getByLabel",
          "getByPlaceholder",
          "getByRole",
          "getByTestId",
          "getByText",
          "last",
          "locator",
          "nth",
          "or",
        ].includes(name)
          ? undefined
          : "playwright",
      })),
    },
    PlaywrightDownload: {
      members: [
        {
          name: "path",
          kind: "method",
          signature: "path(options?): Promise<string | null>",
          command: "playwright",
          documented: false,
        },
      ],
    },
    PlaywrightFileChooser: {
      members: [
        { name: "isMultiple", kind: "method", signature: "isMultiple(): boolean" },
        {
          name: "setFiles",
          kind: "method",
          signature: "setFiles(files, options?): Promise<void>",
          command: "playwright",
          unsupportedByDefaultIn: ["iab"],
        },
      ],
    },
    CUAAPI: {
      members: [
        ...["click", "double_click", "drag", "keypress", "move", "scroll", "type"].map((name) => ({
          name,
          kind: "method" as const,
          signature: `${name}(...)`,
        })),
        {
          name: "downloadMedia",
          kind: "method",
          signature: "downloadMedia(options): Promise<void>",
          unsupportedByDefaultIn: ["iab"] as BrowserBackendType[],
          documented: false,
        },
      ],
    },
    DomCUAAPI: {
      members: [
        ...["click", "double_click", "get_visible_dom", "keypress", "scroll", "type"].map(
          (name) => ({ name, kind: "method" as const, signature: `${name}(...)` }),
        ),
        {
          name: "downloadMedia",
          kind: "method",
          signature: "downloadMedia(options): Promise<void>",
          unsupportedByDefaultIn: ["iab"] as BrowserBackendType[],
          documented: false,
        },
      ],
    },
  },
};

function isManifest(value: unknown): value is BrowserApiManifest {
  if (!value || typeof value !== "object") return false;
  const record = value as { version?: unknown; objects?: unknown };
  return (
    typeof record.version === "number" &&
    Boolean(record.objects && typeof record.objects === "object")
  );
}

export function loadBrowserApiManifest(documentationRoot?: string): BrowserApiManifest {
  if (!documentationRoot) return FALLBACK_MANIFEST;
  const path = join(documentationRoot, "api.json");
  if (!existsSync(path)) return FALLBACK_MANIFEST;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isManifest(parsed) ? parsed : FALLBACK_MANIFEST;
  } catch {
    return FALLBACK_MANIFEST;
  }
}

function capabilityIds(
  descriptor: BrowserBackendDescriptor,
  scope: "browser" | "tab",
): Set<string> {
  return new Set((descriptor.capabilities[scope] ?? []).map((capability) => capability.id));
}

export class BrowserApiPolicy {
  private readonly members = new Map<string, BrowserApiManifestMember>();
  private readonly browserCapabilities: Set<string>;
  private readonly tabCapabilities: Set<string>;

  constructor(
    readonly manifest: BrowserApiManifest,
    private descriptor: BrowserBackendDescriptor,
  ) {
    this.browserCapabilities = capabilityIds(descriptor, "browser");
    this.tabCapabilities = capabilityIds(descriptor, "tab");
    for (const [objectName, object] of Object.entries(manifest.objects)) {
      for (const member of object.members ?? []) {
        this.members.set(`${objectName}.${member.name}`, member);
      }
    }
  }

  isKnown(objectName: string, memberName: string): boolean {
    return this.members.has(`${objectName}.${memberName}`);
  }

  supports(objectName: string, memberName: string): boolean {
    const key = `${objectName}.${memberName}`;
    const member = this.members.get(key);
    if (!member) return true;
    let supported = this.supportsRequirement(member);
    if (supported && member.declarations?.length) {
      supported = member.declarations.some((declaration) => this.supportsRequirement(declaration));
    }
    // connection 级 override 是最后裁决；用于灰度或 adapter 的精确能力修正。
    return this.descriptor.apiSupportOverrides?.[key] ?? supported;
  }

  supportedMembers(objectName: string): BrowserApiManifestMember[] {
    return (this.manifest.objects[objectName]?.members ?? [])
      .filter((member) => this.supports(objectName, member.name))
      .map((member) => ({
        ...member,
        ...(member.declarations
          ? {
              declarations: member.declarations.filter((declaration) =>
                this.supportsRequirement(declaration),
              ),
            }
          : {}),
      }));
  }

  updateDescriptor(descriptor: BrowserBackendDescriptor): void {
    this.descriptor = descriptor;
    this.browserCapabilities.clear();
    this.tabCapabilities.clear();
    for (const id of capabilityIds(descriptor, "browser")) this.browserCapabilities.add(id);
    for (const id of capabilityIds(descriptor, "tab")) this.tabCapabilities.add(id);
  }

  private supportsRequirement(requirement: {
    unsupportedByDefaultIn?: BrowserBackendType[];
    requiresCapabilities?: string[];
  }): boolean {
    if ((requirement.unsupportedByDefaultIn ?? []).includes(this.descriptor.type)) return false;
    return !requirement.requiresCapabilities?.some((capability) => {
      const separator = capability.indexOf(":");
      if (separator > 0) {
        const scope = capability.slice(0, separator);
        const id = capability.slice(separator + 1);
        if (scope === "browser") return !this.browserCapabilities.has(id);
        if (scope === "tab") return !this.tabCapabilities.has(id);
      }
      // 兼容旧 manifest 的无 scope capability id；新版应显式使用 browser:/tab:。
      return !this.browserCapabilities.has(capability) && !this.tabCapabilities.has(capability);
    });
  }
}

/** unsupported member 在读取和 `in` 检查时都不可见，而不是调用后才抛 NotImplemented。 */
export function createBrowserApiProxy<T extends object>(
  target: T,
  objectName: string,
  policy: BrowserApiPolicy,
  options: { hideUnknown?: boolean } = {},
): T {
  const isHidden = (property: PropertyKey) => {
    if (typeof property !== "string") return false;
    const known = policy.isKnown(objectName, property);
    return known ? !policy.supports(objectName, property) : options.hideUnknown === true;
  };
  const handler: ProxyHandler<object> = {
    get(current, property, receiver) {
      if (isHidden(property)) return undefined;
      const value = Reflect.get(current, property, receiver);
      // strict facade 隐藏内部 helper/field；公开 method 绑定原对象，避免 method 内部读取被 proxy 拦截。
      return options.hideUnknown && typeof value === "function" ? value.bind(current) : value;
    },
    has(current, property) {
      if (isHidden(property)) return false;
      return Reflect.has(current, property);
    },
    getOwnPropertyDescriptor(current, property) {
      if (isHidden(property)) return undefined;
      return Reflect.getOwnPropertyDescriptor(current, property);
    },
    ownKeys(current) {
      return Reflect.ownKeys(current).filter((property) => !isHidden(property));
    },
  };
  return new Proxy(target, handler) as T;
}
