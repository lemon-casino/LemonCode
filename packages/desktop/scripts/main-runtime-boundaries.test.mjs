import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, realpath } from "node:fs/promises";
import { resolve, join, relative, isAbsolute, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

// 使用桌面 tsup 实际依赖的编译器，避免 hoisted 的另一版 esbuild 掩盖生产序列化差异。
const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsup"))("esbuild");

const desktopRoot = resolve(import.meta.dirname, "..");

async function cleanupFixtureDirectory(directory) {
  const cache = await realpath(join(desktopRoot, "node_modules/.cache"));
  const target = await realpath(directory);
  const child = relative(cache, target);
  if (!child || isAbsolute(child) || child.split(sep)[0] === "..")
    throw new Error("Fixture cleanup escaped its cache");
  await rm(target, { recursive: true, force: true });
}
const loggerStub = "export const logger={info(){},warn(){},debug(){},error(){}};";
const electronStub = `
export const handlers=new Map();
export const ipcMain={handle:(name,handler)=>handlers.set(name,handler)};
export const BrowserWindow={fromWebContents:()=>null};
export const app={getPath:()=>{throw Error('unexpected application path lookup')}};
export const dialog={showSaveDialog:async()=>({filePath:''})};
export const webContents={}, nativeImage={}, screen={}, session={}, MessageChannelMain={};
`;

async function loadSource(t, relativePath, stubs = {}, compilerOptions = {}) {
  const cache = join(desktopRoot, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "main-boundary-test-"));
  t.after(() => cleanupFixtureDirectory(directory));
  const output = join(directory, "fixture.mjs");
  const source = resolve(desktopRoot, relativePath).replaceAll("\\", "/");
  await build({
    stdin: {
      contents: `export * from ${JSON.stringify(source)};import * as testElectron from 'electron';export {testElectron};`,
      resolveDir: desktopRoot,
    },
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    ...compilerOptions,
    plugins: [
      {
        name: "main-boundary-adapters",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            const stub =
              stubs[args.path] ??
              (args.path === "electron"
                ? electronStub
                : /(?:^|\/)logger\.js$/u.test(args.path)
                  ? loggerStub
                  : undefined);
            if (stub !== undefined)
              return { path: args.path, namespace: "adapter", pluginData: stub };
            if (args.path === "@lcode/shared")
              return { path: resolve(desktopRoot, "../shared/src/index.ts") };
            if (args.path === "@lcode/model-option-map")
              return { path: resolve(desktopRoot, "../model-option-map/src/index.ts") };
          });
          builder.onLoad({ filter: /.*/, namespace: "adapter" }, (args) => ({
            contents: args.pluginData,
            loader: "js",
          }));
        },
      },
    ],
  });
  return import(pathToFileURL(output).href);
}

test("Electron fetch adapter normalizes URL while retaining Request and init", async (t) => {
  const { createDesktopTelemetryFetch } = await loadSource(t, "src/main/desktopTelemetryFetch.ts");
  const calls = [];
  const response = new Response("ok");
  const fetch = createDesktopTelemetryFetch({
    fetch: async (input, init) => {
      calls.push({ input, init });
      return response;
    },
  });
  const init = { method: "POST" };
  assert.equal(await fetch(new URL("https://example.test/telemetry"), init), response);
  assert.equal(calls[0].input, "https://example.test/telemetry");
  assert.equal(calls[0].init, init);
  const request = new Request("https://example.test/request");
  await fetch(request);
  assert.equal(calls[1].input, request);
});

test("PDF IPC copies only visible bytes into an independent ArrayBuffer", async (t) => {
  const { registerDesktopPrintToPdfIpcHandler, testElectron } = await loadSource(
    t,
    "src/main/desktopPrintToPdf.ts",
  );
  registerDesktopPrintToPdfIpcHandler({ warn() {} });
  const source = Buffer.from(new SharedArrayBuffer(16), 3, 4);
  source.set([1, 2, 3, 4]);
  const handler = [...testElectron.handlers.values()][0];
  const result = await handler({ sender: { id: 1, printToPDF: async () => source } });
  assert.equal(result.success, true);
  assert.ok(result.data instanceof ArrayBuffer);
  assert.deepEqual([...new Uint8Array(result.data)], [1, 2, 3, 4]);
  source.fill(9);
  assert.deepEqual([...new Uint8Array(result.data)], [1, 2, 3, 4]);
});

test("isolated default-userData startup never copies identity data", async (t) => {
  const { migrateDesktopIdentityDataSync } = await loadSource(
    t,
    "src/main/desktopDataBaseDirBootstrap.ts",
    {
      "./desktopRuntimeEnv.js":
        "export const runtimeApplicationName='LCode Dev', runtimeUserDataPath=undefined;",
      "@lcode/services/node": "export const setDataBaseDir=()=>{};",
      "@lcode/shared/node":
        "export const migrateDirCopyStyleSync=()=>{throw Error('unexpected data migration')};",
    },
  );
  assert.doesNotThrow(() => migrateDesktopIdentityDataSync());
});

test("save-file IPC retains the validated payload across the save dialog", async (t) => {
  const { registerDesktopSaveFileIpcHandler, testElectron } = await loadSource(
    t,
    "src/main/desktopSaveFile.ts",
  );
  registerDesktopSaveFileIpcHandler({ warn() {} });
  const cache = join(desktopRoot, "node_modules/.cache");
  const directory = await mkdtemp(join(cache, "save-file-test-"));
  t.after(() => cleanupFixtureDirectory(directory));
  const target = join(directory, "saved.bin");
  const payload = { suggestedName: "saved.bin", data: new Uint8Array([2, 4, 6]).buffer };
  testElectron.dialog.showSaveDialog = async () => {
    payload.data = undefined;
    return { filePath: target };
  };
  const handler = [...testElectron.handlers.values()][0];
  const result = await handler({ sender: {} }, payload);
  assert.equal(result.success, true);
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual([...(await readFile(target))], [2, 4, 6]);
});

test("remote save pins the full validated DNS address list to the connection", async (t) => {
  const { registerDesktopSaveFileIpcHandler, testElectron } = await loadSource(
    t,
    "src/main/desktopSaveFile.ts",
    {
      "node:dns/promises":
        "export async function lookup(host,options){if(!options.all)throw Error('expected all DNS addresses');return [{address:'1.1.1.1',family:4}]}",
      undici: `export class Agent {constructor(options){this.options=options}async close(){}}
export async function fetch(url,init){await new Promise((resolve,reject)=>init.dispatcher.options.connect.lookup(url.hostname,{all:true},(error,addresses)=>{if(error)return reject(error);if(!Array.isArray(addresses)||addresses[0].address!=='1.1.1.1')return reject(Error('DNS not pinned'));resolve()}));return {status:200,ok:true,headers:{get:()=> '2'},body:new ReadableStream({start(controller){controller.enqueue(new Uint8Array([8,9]));controller.close()}})}}`,
    },
  );
  registerDesktopSaveFileIpcHandler({ warn() {} });
  const directory = await mkdtemp(join(desktopRoot, "node_modules/.cache/save-file-test-"));
  t.after(() => cleanupFixtureDirectory(directory));
  const target = join(directory, "remote.bin");
  testElectron.dialog.showSaveDialog = async () => ({ filePath: target });
  const result = await [...testElectron.handlers.values()][0](
    { sender: {} },
    { suggestedName: "remote.bin", sourceUrl: "https://download.example.test/image.png" },
  );
  assert.equal(result.success, true);
  const { readFile } = await import("node:fs/promises");
  assert.deepEqual([...(await readFile(target))], [8, 9]);
});

test("invalid save payloads are rejected before opening a dialog", async (t) => {
  const { registerDesktopSaveFileIpcHandler, testElectron } = await loadSource(
    t,
    "src/main/desktopSaveFile.ts",
  );
  registerDesktopSaveFileIpcHandler({ warn() {} });
  testElectron.dialog.showSaveDialog = async () => {
    throw Error("invalid payload opened a dialog");
  };
  const handler = [...testElectron.handlers.values()][0];
  for (const data of [undefined, new ArrayBuffer(0), new SharedArrayBuffer(4)]) {
    assert.deepEqual(await handler({ sender: {} }, { suggestedName: "invalid.bin", data }), {
      success: false,
      error: "invalid_file_payload",
    });
  }
});

test("a tab closed while awaiting its viewport cannot leak into public summaries", async (t) => {
  const { BrowserGuestManager } = await loadSource(
    t,
    "src/main/browserView/browserGuestManager.ts",
  );
  const manager = new BrowserGuestManager();
  const tab = {
    tabId: "test-tab",
    lifecycle: "active",
    cachedUrl: "https://example.test",
    cachedTitle: "Test",
    owner: {},
  };
  manager.readTabViewport = async () => {
    tab.lifecycle = "closed";
    return { width: 800, height: 600 };
  };
  await assert.rejects(manager.summary(tab), { name: "AbortError" });
});

test("guest recovery rechecks closed state after its asynchronous restore", async (t) => {
  const { BrowserGuestManager } = await loadSource(
    t,
    "src/main/browserView/browserGuestManager.ts",
  );
  const manager = new BrowserGuestManager();
  const guest = {};
  const tab = { lifecycle: "active", guest };
  manager.restoreGuestState = async () => {
    tab.lifecycle = "closed";
    return true;
  };
  assert.equal(await manager.restoreReboundGuest(tab, guest), null);
});

test("guest closed during recovery persistence cannot be returned as ready", async (t) => {
  const { BrowserGuestManager } = await loadSource(
    t,
    "src/main/browserView/browserGuestManager.ts",
  );
  const manager = new BrowserGuestManager();
  const guest = {};
  const tab = { lifecycle: "active", guest };
  manager.restoreGuestState = async () => true;
  manager.persistShell = async () => {
    tab.lifecycle = "closed";
  };
  assert.equal(await manager.restoreReboundGuest(tab, guest), null);
});

test("relay batching preserves text order and leaves opaque non-text payloads untouched", async (t) => {
  const { TaskRealtimeBus } = await loadSource(t, "src/main/taskRealtimeBus.ts");
  const bus = new TaskRealtimeBus({ logger: { info() {}, warn() {} } });
  const text = (content, traceId = "test-run") => ({
    kind: "stream_event",
    event: { type: "agent_message_chunk", taskId: "test-task", traceId, content },
  });
  const merged = bus.coalesceOps([text("a"), text("b"), text("c", "other-run")]);
  assert.deepEqual(
    merged.map((op) => op.event.content),
    ["ab", "c"],
  );
  const opaque = {
    kind: "stream_event",
    event: { type: "agent_message_chunk", taskId: "test-task", traceId: "test-run", content: null },
  };
  assert.deepEqual(bus.splitLargeTextOps([opaque]), [opaque]);
  const large = "x".repeat(128 * 1024 + 8);
  const parts = bus.splitLargeTextOps([text(large)]);
  assert.equal(parts.length, 2);
  assert.equal(parts.map((op) => op.event.content).join(""), large);
});

test("owner leases and invalidation order hold for desktop and mobile delivery kinds", async (t) => {
  const { TaskRealtimeBus } = await loadSource(t, "src/main/taskRealtimeBus.ts");
  for (const deliveryKind of ["desktop_window", "relay_bridge"]) {
    const bus = new TaskRealtimeBus({ logger: { info() {}, warn() {} } });
    const owner = new EventEmitter();
    const observer = new EventEmitter();
    const ownerMessages = [],
      observerMessages = [];
    owner.postMessage = (message) => ownerMessages.push(message);
    observer.postMessage = (message) => observerMessages.push(message);
    bus.registerHost({
      hostId: "owner",
      windowId: 1,
      child: owner,
      workspaceKeys: ["/fixture/main"],
      deliveryKind,
    });
    bus.registerHost({
      hostId: "observer",
      windowId: 2,
      child: observer,
      workspaceKeys: ["/fixture/main"],
    });
    const target = {
      workspacePath: "/fixture/main",
      workspaceKey: "/fixture/main",
      taskId: "test-task",
      runId: "test-run",
      traceId: "test-run",
    };
    owner.emit("message", {
      type: "task-run-lease-acquire",
      request: { ...target, leaseRequestId: "lease-test" },
    });
    assert.equal(ownerMessages.at(-1).result.acquired, true);
    const publish = (child, content, runId = target.runId) =>
      child.emit("message", {
        type: "task-stream-op-publish",
        target: { ...target, runId, traceId: runId },
        op: {
          kind: "stream_event",
          event: { type: "agent_message_chunk", taskId: target.taskId, traceId: runId, content },
        },
      });
    publish(observer, "wrong-owner");
    publish(owner, "stale", "previous-run");
    publish(owner, "a");
    publish(owner, "b");
    owner.emit("message", {
      type: "task-realtime-publish",
      event: {
        type: "task_snapshot_invalidated",
        eventId: "invalidation-test",
        workspacePath: target.workspacePath,
        workspaceKey: target.workspaceKey,
        taskId: target.taskId,
        traceId: target.traceId,
        createdAt: 1,
        reason: "assistant_message_saved",
      },
    });
    const events = observerMessages
      .filter((message) => message.type === "task-realtime-deliver")
      .map((message) => message.event);
    assert.deepEqual(
      events.map((event) => event.type),
      ["task_stream_mirror_batch", "task_snapshot_invalidated"],
    );
    assert.equal(events[0].ops[0].event.content, "ab");
    assert.equal(events[0].deliveryPurpose, "observer");
    assert.equal(
      ownerMessages.find((message) => message.event?.type === "task_stream_mirror_batch").event
        .deliveryPurpose,
      "relay_owner",
    );
    bus.unregisterHost("owner");
    bus.unregisterHost("observer");
  }
});

test(
  "serialized page helpers work in Chromium without a Main closure",
  { skip: !process.env.LCODE_TEST_BROWSER_PATH },
  async (t) => {
    const { elementInfoRuntime, overlayRuntime } = await loadSource(
      t,
      "src/browserRuntime/playwrightPageHelpers.ts",
      {},
      { minify: true, keepNames: true, target: "node22" },
    );
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({
      executablePath: process.env.LCODE_TEST_BROWSER_PATH,
      headless: true,
    });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.setContent(
      '<button id="save:button" data-testid="save" style="position:absolute;left:20px;top:20px;width:120px;height:40px">Save</button>',
    );
    const params = { x: 30, y: 30 };
    const info = await page.evaluate(
      `(${elementInfoRuntime.toString()})(${JSON.stringify(params)})`,
    );
    assert.equal(info[0].role, "button");
    assert.equal(info[0].visibleText, "Save");
    assert.equal(info[0].selector.primary, "#save\\:button");
    await page.evaluate(`(${overlayRuntime.toString()})(${JSON.stringify(params)})`);
    assert.equal(await page.locator("#__lcode-playwright-element-screenshot-overlay").count(), 1);
    await page.evaluate(
      `(${overlayRuntime.toString()})(${JSON.stringify({ ...params, remove: true })})`,
    );
    assert.equal(await page.locator("#__lcode-playwright-element-screenshot-overlay").count(), 0);
  },
);
