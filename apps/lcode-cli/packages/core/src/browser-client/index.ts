import {
  BrowsersFacade,
  type BrowserAvailabilityGuard,
  type BrowserClientTransport,
} from "./facade.js";
import { loadBrowserDocumentation } from "./documentation.js";

export {
  BrowsersFacade,
  Browser,
  BrowserTabs,
  BrowserRecordingAPI,
  type BrowserTabInfo,
  RawTab,
  Tab,
  type BrowserBackendType,
  type BrowserAvailabilityGuard,
  type BrowserCapabilityInfo,
  type BrowserClientTransport,
  type BrowserExecuteFn,
  type BrowserTransportExecuteFn,
  type BrowserInfo,
  type BrowserDescriptor,
} from "./facade.js";
export { BrowserCommandError } from "./result.js";
export {
  PlaywrightAPI,
  PlaywrightDownload,
  PlaywrightFileChooser,
  PlaywrightFrameLocator,
  PlaywrightLocator,
  type ElementInfo,
  type KeyboardModifier,
  type LoadState,
  type TextMatcher,
  type WaitUntil,
} from "./playwright.js";
export { selectBrowserForUrl, selectDefaultBrowser } from "./selection.js";
export {
  BrowserApiPolicy,
  createBrowserApiProxy,
  loadBrowserApiManifest,
  type BrowserApiManifest,
  type BrowserApiManifestMember,
} from "./manifest.js";

export function setupBrowserRuntime(opts: {
  globals: Record<string, unknown>;
  transport: BrowserClientTransport;
  documentationRoot?: string;
  assertAvailable?: BrowserAvailabilityGuard;
}): void {
  opts.assertAvailable?.();
  const agent = (opts.globals.agent ??= {}) as {
    browsers?: BrowsersFacade;
    documentation?: { get(name: string): Promise<string> };
  };
  agent.browsers = new BrowsersFacade(opts.transport, {
    documentationRoot: opts.documentationRoot,
    assertAvailable: opts.assertAvailable,
  }).asRuntimeObject();
  const previousDocumentation = agent.documentation;
  const previousGet = previousDocumentation?.get;
  agent.documentation = Object.freeze({
    get: async (name: string) => {
      opts.assertAvailable?.();
      if (!name) throw new TypeError("agent.documentation.get requires a document name");
      if (name === "computer-use" && previousGet) return await previousGet(name);
      return loadBrowserDocumentation(opts.documentationRoot, name);
    },
  });
}
