import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserBackendDescriptor } from "@lcode/contracts/browser-control";
import { BrowserApiPolicy, loadBrowserApiManifest, type BrowserApiManifest } from "./manifest.js";

interface BrowserDocumentsManifest {
  documents?: Array<{
    path?: string;
    title?: string;
    name?: string;
    mode?: "included" | "lookup";
    description?: string;
    when?: {
      browserTypes?: BrowserBackendDescriptor["type"][];
      requiredApiMembers?: string[];
      requiredBrowserCapabilities?: string[];
      requiredTabCapabilities?: string[];
    };
  }>;
  title?: string;
  version?: number;
}

function documentApplies(
  document: NonNullable<BrowserDocumentsManifest["documents"]>[number],
  descriptor: BrowserBackendDescriptor | undefined,
  api: BrowserApiManifest,
): boolean {
  const when = document.when;
  if (!when) return true;
  if (!descriptor) return false;
  if (when.browserTypes && !when.browserTypes.includes(descriptor.type)) return false;
  const browserCapabilities = new Set(
    (descriptor.capabilities.browser ?? []).map((capability) => capability.id),
  );
  const tabCapabilities = new Set(
    (descriptor.capabilities.tab ?? []).map((capability) => capability.id),
  );
  if (when.requiredBrowserCapabilities?.some((id) => !browserCapabilities.has(id))) return false;
  if (when.requiredTabCapabilities?.some((id) => !tabCapabilities.has(id))) return false;
  if (when.requiredApiMembers?.length) {
    const policy = new BrowserApiPolicy(api, descriptor);
    if (
      when.requiredApiMembers.some((member) => {
        const separator = member.indexOf(".");
        return (
          separator <= 0 ||
          !policy.supports(member.slice(0, separator), member.slice(separator + 1))
        );
      })
    ) {
      return false;
    }
  }
  return true;
}

const FALLBACK_DOCUMENTATION = [
  "# Built-in Browser Automation API",
  "",
  // Browser Use MCP 已是每次调用 fresh kernel；fallback 不能继续诱导模型复用 global binding。
  "The official browser-use plugin docs are unavailable, and every Browser Use call starts in a fresh kernel. Start with `await agent.browsers.list()`, then select a reported runtime browser with `const browser = await agent.browsers.getDefault()` or the matching `get()` / `getForUrl(url)` selection. Repeat the same verified selection in each call without switching backend.",
  "Backend types are `iab | extension | cdp`; Playwright is a tab API surface, not a backend. Never assume an unlisted backend is available.",
  "High-level methods return payloads directly and throw `BrowserCommandError` on failure.",
  "Before each logical tab-operation batch, return the complete `browser.tabs.list()` result in a dedicated observation cell. Each `TabInfo` includes `viewport: BrowserViewportSize`. After the model inspects the list, match by stable id or verified URL/title and call `tabs.get(id)` in the next cell; if no controlled tab matches, inspect and claim `browser.user.openTabs()` before creating a new tab.",
  // 模型每次对同站 URL 都走 tabs.new()，任务结束后 IAB 堆满标签页。
  // open() 现在内置同站复用（激活 + 原地跳转），文档必须把 open() 教成默认导航入口。
  "`agent.browsers.open(url)` is the default navigation entry: it reuses an existing same-site controlled tab (same hostname), activates it so the user sees it, and navigates in place instead of stacking new tabs. Only pass `{ reuseTab: false }` (or use `browser.tabs.new()`) when the task genuinely needs a parallel independent tab.",
  "For a genuinely new URL with no intended existing page, use `const tab = await browser.tabs.new()`, run `await tab.goto(url)`, then run `await tab.playwright.waitForLoadState({ state: \"domcontentloaded\" })` before returning the first title, URL, or DOM observation.",
  "After every successful `tab.goto(url)`, explicitly call `await tab.playwright.waitForLoadState({ state: \"domcontentloaded\" })` before the first title, URL, or DOM observation. Keep this confirmation in the model-visible trajectory even when goto() has already settled the backend navigation. Do not replace it with networkidle or a fixed sleep; routine URL/load-state waits remain capped at 3000ms.",
  "If the latest domSnapshot already contains the target, use its facts directly. Do not use evaluate() to rediscover related elements, enumerate inputs, dump HTML, walk the DOM, or probe guessed selectors.",
  "Never guess locator labels, accessible names, placeholders, selectors, or URL patterns. If count() is 0, do not action-wait: take a fresh domSnapshot() and rebuild. After timeout/strict/parse failure, never retry the same locator.",
  // 快照里的 heading/text 可能由祖先卡片处理点击，不能因缺少 link role 就放弃或猜测新角色。
  "A snapshot-proven heading or visible text does not need a `link` or `button` role to be clicked. Do not replace a snapshot-proven `heading` with a guessed `link` role. When user intent authorizes navigation and the actual target is unique, click it directly.",
  // 两套 tab 查询分开返回时，模型会在第一套结果后重新决策并跳过 popup 来源。
  "Use at most one state-changing action per observation cycle. An unchanged source-tab URL does not prove the click failed. Judge an action by whether its expected effect appeared, not by whether `browser.tabs.list()` is non-empty. An existing source tab or unrelated controlled tab is not an action effect. When an action may open a popup/new tab and the source tab does not show the expected effect, read `browser.tabs.list()` and `browser.user.openTabs()` unconditionally in the same observation cell. Prefer `const [controlledTabs, userTabs] = await Promise.all([browser.tabs.list(), browser.user.openTabs()]);`. Return `{ controlledTabs, userTabs }` as that cell's final result so the model makes one decision from both lists. Do not return the controlled list first or decide whether to query user tabs from its contents.",
  "playwright.evaluate() and locator.evaluate() execute JavaScript in the page context and may change page state. Use them for page-side logic that cannot be expressed through the high-level locator API; use normal action methods when they communicate the intended interaction more clearly.",
  "Routine locator, URL/load-state wait, and evaluate operations default to and are capped at 3000ms; fixed tab.playwright.waitForTimeout(ms) is separate.",
].join("\n");

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readMarkdown(root: string, relativePath: string): string | undefined {
  const path = join(root, relativePath);
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function formatApi(api: BrowserApiManifest | undefined): string {
  if (!api) return "";
  const lines: string[] = [];
  lines.push("## API manifest");
  if (api.entrypoints && api.entrypoints.length > 0) {
    lines.push("- entrypoints:");
    for (const entrypoint of api.entrypoints) lines.push(`  - \`${entrypoint}\``);
  }
  if (api.semantics) {
    lines.push("- semantics:");
    for (const [key, value] of Object.entries(api.semantics)) lines.push(`  - ${key}: ${value}`);
  }
  if (api.types) {
    lines.push("- types:");
    for (const [name, declaration] of Object.entries(api.types)) {
      lines.push(`  - \`${name}\`: \`${declaration}\``);
    }
  }
  if (api.objects) {
    lines.push("- objects:");
    for (const [name, object] of Object.entries(api.objects)) {
      lines.push(`  - ${name}`);
      for (const member of object.members ?? []) {
        if (member.documented === false) continue;
        const signatures = member.declarations?.length
          ? member.declarations
              .filter((declaration) => declaration.documented !== false)
              .map((declaration) => declaration.signature)
          : [member.signature];
        for (const signature of signatures) lines.push(`    - ${member.kind} \`${signature}\``);
      }
    }
  }
  return lines.join("\n");
}

function effectiveApi(
  api: BrowserApiManifest,
  descriptor?: BrowserBackendDescriptor,
): BrowserApiManifest {
  if (!descriptor) {
    // 全局 documentation() 是同步入口，不能在这里伪造一个 backend。只展示所有连接都安全成立的
    // common surface；connection-specific/override 成员由 browser.documentation() 展示。
    return {
      ...api,
      objects: Object.fromEntries(
        Object.entries(api.objects).map(([objectName, object]) => [
          objectName,
          {
            members: object.members
              .filter(
                (member) =>
                  (member.unsupportedByDefaultIn?.length ?? 0) === 0 &&
                  (member.requiresCapabilities?.length ?? 0) === 0,
              )
              .map((member) => ({
                ...member,
                ...(member.declarations
                  ? {
                      declarations: member.declarations.filter(
                        (declaration) =>
                          (declaration.unsupportedByDefaultIn?.length ?? 0) === 0 &&
                          (declaration.requiresCapabilities?.length ?? 0) === 0,
                      ),
                    }
                  : {}),
              })),
          },
        ]),
      ),
    };
  }
  const policy = new BrowserApiPolicy(api, descriptor);
  return {
    ...api,
    objects: Object.fromEntries(
      Object.keys(api.objects).map((objectName) => [
        objectName,
        { members: policy.supportedMembers(objectName) },
      ]),
    ),
  };
}

export function loadBrowserDocumentation(
  documentationRoot?: string,
  name?: string,
  descriptor?: BrowserBackendDescriptor,
): string {
  if (!documentationRoot) {
    if (name) throw new Error(`Browser documentation not found: ${name}`);
    return FALLBACK_DOCUMENTATION;
  }
  const apiPath = join(documentationRoot, "api.json");
  const hasApi = existsSync(apiPath);
  const api = loadBrowserApiManifest(documentationRoot);
  const manifest = readJson<BrowserDocumentsManifest>(join(documentationRoot, "documents.json"));
  if (!hasApi && !manifest) {
    if (name) throw new Error(`Browser documentation not found: ${name}`);
    return FALLBACK_DOCUMENTATION;
  }

  if (name) {
    const document = manifest?.documents?.find((candidate) => {
      const pathName = candidate.path?.replace(/\.md$/u, "");
      return (
        (candidate.name === name || pathName === name) &&
        documentApplies(candidate, descriptor, api)
      );
    });
    const markdown = document?.path ? readMarkdown(documentationRoot, document.path) : undefined;
    if (!markdown) throw new Error(`Browser documentation not found: ${name}`);
    return markdown;
  }

  const sections: string[] = [];
  if (descriptor) {
    sections.push(
      [
        "# Selected Browser",
        `- Name: ${descriptor.name}`,
        `- Type: ${descriptor.type}`,
        `- ID: ${descriptor.id}`,
        // Browser descriptor 持久，但承载它的 JavaScript wrapper 每次调用都会销毁。
        "Recreate this browser wrapper in every fresh Browser Use call using the same verified selection. A new user turn, fresh kernel, or tab error does not invalidate the browser backend; select another browser only when the browser-selection policy requires it.",
        "If a tab is stale or missing later, recover or create a tab after inspecting current tab facts; never switch browser backend merely to recover a tab. Empty controlled-tab lists are normal after explicit close or session release and do not invalidate the selected browser backend.",
      ].join("\n"),
    );
  }
  const title = manifest?.title ?? "Built-in Browser Automation API";
  sections.push(`# ${title}`);
  const apiText = formatApi(effectiveApi(api, descriptor));
  if (apiText) sections.push(apiText);
  for (const doc of manifest?.documents ?? []) {
    if (!doc.path || doc.mode === "lookup" || !documentApplies(doc, descriptor, api)) continue;
    const markdown = readMarkdown(documentationRoot, doc.path);
    if (markdown) sections.push(markdown);
  }
  return sections.filter(Boolean).join("\n\n").trim() || FALLBACK_DOCUMENTATION;
}
