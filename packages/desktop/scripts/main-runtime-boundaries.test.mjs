import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { resolve, join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import {
  cleanupFixtureDirectory,
  desktopRoot,
  loadSource,
  loadMacUpdateRuntime,
} from "./main-runtime-test-fixture.mjs";

test("macOS system helper lifecycle regressions run in the release gate", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      "--test-reporter=tap",
      resolve(desktopRoot, "src/main/macUpdateInstall.test.ts"),
    ],
    {
      cwd: resolve(desktopRoot, "../.."),
      timeout: 15_000,
      // Node 测试 worker 标记不能传给独立 runner，否则嵌套 --test 会被跳过。
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.match(stdout, /# pass 4\b/u);
});

test("macOS update IPC prepares once, exits through the helper, and preserves ready on handoff failure", async (t) => {
  const runtime = await loadMacUpdateRuntime(t);
  t.after(() => runtime.initAutoUpdater({ enabled: false }));
  const { updater, events, controls, handlers } = runtime.testElectron;
  let releasePreparation;
  const preparation = new Promise((resolve) => {
    releasePreparation = resolve;
  });
  let preparationFailure;
  await runtime.initAutoUpdater({
    onBeforeQuitAndInstall: async () => {
      events.push("prepare-start");
      await preparation;
      if (preparationFailure) throw preparationFailure;
      events.push("prepare-end");
    },
  });
  updater.emit("update-available", { version: "4.0.0" });
  await new Promise((resolve) => setImmediate(resolve));
  handlers.get("lcode:download-update")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.getAutoUpdaterState().kind, "update-downloaded");
  const install = handlers.get("lcode:quit-and-install-update");
  controls.handoffFailure = true;
  const firstInstall = install();
  await install();
  assert.deepEqual(events, ["prepare-start"], "并发请求不能绕过退出准备或创建第二个 helper");
  releasePreparation();
  await assert.rejects(firstInstall, /helper spawn failed/u);
  assert.deepEqual(events, ["prepare-start", "prepare-end", "handoff:/fixture/verified-LCode.dmg"]);
  assert.equal(runtime.getAutoUpdaterState().kind, "update-downloaded");
  controls.handoffFailure = false;
  events.length = 0;
  await install();
  assert.deepEqual(events, [
    "prepare-start",
    "prepare-end",
    "handoff:/fixture/verified-LCode.dmg",
    "exit:0",
  ]);
  events.length = 0;
  preparationFailure = new Error("prepare failed");
  await assert.rejects(install(), /prepare failed/u);
  assert.deepEqual(events, ["prepare-start"], "退出准备失败不能启动安装 helper");
});

test("packaged Main registers bundled resources only for the matching compile mode", async (t) => {
  const resources = resolve(desktopRoot, "node_modules/.cache/fixture-resources");
  for (const bundled of [true, false]) {
    const runtime = await loadSource(
      t,
      "src/main/desktopRuntimeEnv.ts",
      {
        "./desktopElectronApp.js": `export const isElectronAppPackaged=()=>true;export const getElectronAppPath=()=>${JSON.stringify(resources)};`,
        "@lcode/services/node":
          "export const listSSHConfigAliasesFromLocalConfig=async()=>[];export const getAppConfigDir=()=>'';export const getDataBaseDir=()=>'';export const LCODE_CUA_BUNDLED_HELPER_APP_PATH_ENV='helper';export const LCODE_WINDOWS_APP_INSTALL_DIR_ENV='install';",
      },
      {
        define: {
          __LCODE_BUNDLE_REMOTE_ASSETS__: JSON.stringify(bundled),
          "process.resourcesPath": JSON.stringify(resources),
        },
      },
    );
    const dirs = runtime.resolveRemoteAssetDirs(
      {},
      {
        LCODE_REMOTE_ASSET_CDN_BASE_URL: "https://fixture.invalid/assets",
        LCODE_REMOTE_ASSET_CACHE_DIR: join(resources, "cache"),
      },
    );
    assert.equal(dirs.bundledAssetDir, bundled ? join(resources, "remote-assets") : undefined);
    assert.equal(dirs.remoteCacheDir, join(resources, "cache"));
    assert.equal(dirs.mockCdnDir, undefined);
  }
});

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
