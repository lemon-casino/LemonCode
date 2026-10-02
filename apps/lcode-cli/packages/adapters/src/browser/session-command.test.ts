import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Browser, BrowserContext, Dialog, Page } from "playwright-core";
import type { BrowserCommand } from "@lcode/contracts";
import { createManagedCdpBrowserRuntime, type PlaywrightChromiumModule } from "./index.js";
import { ManagedCdpSession } from "./session.js";
import { executeSessionCommand } from "./session-command.js";

test("session dispatch uses the original tab/dialog owner and keeps unsupported guards", async () => {
  const context = new FakeContext();
  const session = new ManagedCdpSession(context as unknown as BrowserContext);
  const created = await executeSessionCommand(session, { method: "newTab" });
  assert.equal(created.ok, true);
  assert.equal(created.tab?.tabId, session.activeTabId);
  assert.equal((await executeSessionCommand(session, { method: "list" })).tabs?.length, 1);
  await executeSessionCommand(session, { method: "browserViewportSet", width: 640, height: 480 });
  assert.deepEqual(context.pages()[0]?.viewportSize(), { width: 640, height: 480 });
  await executeSessionCommand(session, { method: "browserViewportReset" });
  assert.deepEqual(context.pages()[0]?.viewportSize(), { width: 1280, height: 720 });
  const accepted: unknown[] = [];
  const dialog = {
    type: () => "prompt",
    message: () => "fixture prompt",
    defaultValue: () => "default",
    async accept(text?: string) {
      accepted.push(text);
    },
  } as unknown as Dialog;
  context.pages()[0]?.emit("dialog", dialog);
  assert.deepEqual((await executeSessionCommand(session, { method: "getDialog" })).dialog, {
    type: "prompt",
    message: "fixture prompt",
    defaultPrompt: "default",
  });
  await executeSessionCommand(session, {
    method: "handleDialog",
    accept: true,
    promptText: "answer",
  });
  assert.deepEqual(accepted, ["answer"]);
  assert.equal((await executeSessionCommand(session, { method: "getDialog" })).dialog, null);
  await assert.rejects(
    executeSessionCommand(session, { method: "handleDialog", accept: false }),
    /No JavaScript dialog/,
  );
  assert.equal(
    (await executeSessionCommand(session, { method: "capabilities" })).error?.code,
    "capability_unsupported",
  );
  assert.equal(
    (await executeSessionCommand(session, { method: "navigate", url: "file:///private" })).error
      ?.code,
    "navigation_blocked",
  );
  await executeSessionCommand(session, { method: "close" });
  assert.deepEqual(session.tabIds, []);
});

test("managed runtime retains one session context and rejects stale backend generations", async () => {
  const browser = new FakeBrowser();
  let launches = 0;
  const runtime = createManagedCdpBrowserRuntime({
    executablePath: process.execPath,
    loadPlaywright: async () =>
      ({
        chromium: {
          async launch() {
            launches += 1;
            return browser;
          },
        },
      }) as unknown as PlaywrightChromiumModule,
  });
  try {
    const [descriptor] = await runtime.browserControlPort.list({ sessionId: "session" });
    assert.ok(descriptor);
    const execute = (command: BrowserCommand) =>
      runtime.browserControlPort.execute({
        browserId: descriptor.id,
        browserGeneration: descriptor.generation,
        sessionId: "session",
        command,
      });
    const [left, right] = await Promise.all([
      execute({ method: "newTab" }),
      execute({ method: "newTab" }),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    assert.equal(browser.contexts.length, 1);
    assert.equal(launches, 1);
    assert.equal((await execute({ method: "list" })).tabs?.length, 2);
    const stale = await runtime.browserControlPort.execute({
      browserId: descriptor.id,
      browserGeneration: descriptor.generation + 1,
      sessionId: "session",
      command: { method: "newTab" },
    });
    assert.equal(stale.error?.code, "backend_unavailable");
    assert.equal(browser.contexts.length, 1);
    await runtime.browserControlPort.closeSession?.({ sessionId: "session" });
    assert.equal(browser.contexts[0]?.closed, true);
    assert.equal(browser.connected, false);
  } finally {
    await runtime.close();
  }
  assert.equal(createManagedCdpBrowserRuntime.length, 0);
});

class FakePage extends EventEmitter {
  private closed = false;
  private viewport = { width: 1280, height: 720 };
  isClosed(): boolean {
    return this.closed;
  }
  url(): string {
    return "about:blank";
  }
  async title(): Promise<string> {
    return "fixture";
  }
  viewportSize(): { width: number; height: number } {
    return this.viewport;
  }
  async setViewportSize(viewport: { width: number; height: number }): Promise<void> {
    this.viewport = viewport;
  }
  async bringToFront(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  closed = false;
  private readonly openPages: FakePage[] = [];
  constructor(private readonly owner?: FakeBrowser) {
    super();
  }
  pages(): FakePage[] {
    return this.openPages;
  }
  browser(): Browser | undefined {
    return this.owner as unknown as Browser | undefined;
  }
  async newPage(): Promise<Page> {
    const page = new FakePage();
    this.openPages.push(page);
    this.emit("page", page);
    return page as unknown as Page;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeBrowser extends EventEmitter {
  connected = true;
  readonly contexts: FakeContext[] = [];
  isConnected(): boolean {
    return this.connected;
  }
  async newContext(): Promise<BrowserContext> {
    const context = new FakeContext(this);
    this.contexts.push(context);
    return context as unknown as BrowserContext;
  }
  async close(): Promise<void> {
    this.connected = false;
    this.emit("disconnected");
  }
}
