/* eslint-disable max-lines -- 行为矩阵十个场景 + 入参契约/词表/DPI/PNG 纯函数用例同文件承载，拆分会割裂对同一 spec 矩阵的对照阅读。 */
// 行为矩阵单测：mock 驱动 + mock/缺省权限门注入（spec「验收场景」）。
// 运行：pnpm --dir packages/zcode-cua test（node --test index.test.js，纯 ESM、无构建、不触原生 addon）。
import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import { inflateSync } from "node:zlib";
import { mintBrokerSocketPath } from "./broker.js";
import { computePointerScale, resolveNutKeyName, toLogicalPoint } from "./cua-driver.js";
import { encodeRgbPng } from "./png.js";
import {
  createBrokerComputerUseRuntime,
  createBrokerPermissionGate,
  createComputerUseRuntimeWithDriver,
  UNAVAILABLE_TEXT,
} from "./runtime.js";

test("broker runtime rejects malformed dynamic credentials without throwing", async () => {
  let runtime;
  assert.doesNotThrow(() => {
    runtime = createBrokerComputerUseRuntime({
      brokerSocketPath: 42,
      brokerCapability: {},
      brokerGeneration: "0",
      env: { ZCODE_CUA_PERMISSION_BROKER_SOCKET: Symbol("bad") },
    });
  });
  assertUnavailable(
    await runtime.execute({ toolName: "list_apps", context: mainContext() }),
    "malformed credentials must fail closed",
  );
});

test("broker runtime preserves authenticated product errors instead of reporting build unavailable", async (t) => {
  const socketPath = mintBrokerSocketPath();
  const server = createServer((socket) => {
    let pending = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(pending.slice(0, newline));
      socket.end(
        `${JSON.stringify({
          id: request.id,
          ok: false,
          error: {
            code: "app_not_found",
            message: "No installed application matched QQ",
            details: { app_ref: { name: "QQ" } },
            possibly_sent: false,
            retryable: false,
          },
        })}\n`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  );

  const runtime = createBrokerComputerUseRuntime({
    brokerSocketPath: socketPath,
    brokerCapability: "test-authority",
    brokerGeneration: 0,
  });
  const result = await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { name: "QQ" } },
    context: mainContext(),
  });

  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, /not available in this build/u);
  assert.deepEqual(JSON.parse(result.content[0].text), {
    code: "app_not_found",
    message: "No installed application matched QQ",
    details: { app_ref: { name: "QQ" } },
    action_sent: false,
    dispatch_status: "not_sent",
    retryable: false,
  });
});

test("broker runtime execute deadline covers the producer launch readiness budget", async () => {
  let brokerRequest;
  const runtime = createBrokerComputerUseRuntime({
    brokerSocketPath: "test-socket",
    brokerCapability: "test-authority",
    brokerGeneration: 0,
    async callBrokerMethod(request) {
      brokerRequest = request;
      return { content: [] };
    },
  });

  await runtime.execute({
    toolName: "get_app_state",
    arguments: { app_ref: { name: "QQ" } },
    context: mainContext(),
  });

  assert.equal(brokerRequest.method, "execute");
  assert.equal(brokerRequest.timeoutMs, 30_000);
});

function mainContext(overrides = {}) {
  return {
    sessionId: "session-1",
    runtimeScope: "main",
    workspaceKey: "ws-key",
    ...overrides,
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createMockDriver() {
  const calls = [];
  const record = (name) => async (input) => {
    calls.push({ name, input });
  };
  return {
    calls,
    screenshot: async () => {
      calls.push({ name: "screenshot" });
      return { data: "c2hvdA==", mimeType: "image/png", width: 2560, height: 1440 };
    },
    move: record("move"),
    click: record("click"),
    doubleClick: record("doubleClick"),
    drag: record("drag"),
    type: record("type"),
    key: record("key"),
    scroll: record("scroll"),
    dispose: record("dispose"),
  };
}

// 等到指定动作真正进入驱动执行（微任务链有多跳，固定 tick 数会踩空）。
async function waitForDriverDispatch(driver, count = 1) {
  for (let i = 0; i < 200 && driver.calls.length < count; i += 1) {
    await new Promise((done) => setTimeout(done, 1));
  }
  assert.ok(driver.calls.length >= count, "driver action was not dispatched in time");
}

function createRecordingGate() {
  const state = { authorizeCalls: 0, granted: true };
  return {
    state,
    authorize: async () => {
      state.authorizeCalls += 1;
      return state.granted;
    },
  };
}

function assertUnavailable(result, message) {
  assert.deepEqual(
    result,
    {
      content: [{ type: "text", text: UNAVAILABLE_TEXT }],
      isError: true,
    },
    message,
  );
}

// 驱动「动作」调用数（排除 dispose 记录）
function actionCalls(driver) {
  return driver.calls.filter((call) => call.name !== "dispose");
}

test("矩阵1：放行时 screenshot 签发官方帧对（栅格 + 引用文本 + integrity _meta），isError 缺省", async () => {
  const driver = createMockDriver();
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const result = await runtime.execute({ toolName: "screenshot", context: mainContext() });
  // mock 驱动的 data/mimeType 在 image 内容块中原样出现、零改写
  assert.deepEqual(result.content[0], { type: "image", data: "c2hvdA==", mimeType: "image/png" });
  // 栅格之后紧跟官方帧引用文本，_meta 带 integrity 键
  const ref = JSON.parse(result.content[1].text);
  assert.equal(result.content[1].type, "text");
  assert.equal(ref.type, "zcode_cua_frame_ref");
  assert.equal(ref.schemaVersion, 1);
  assert.ok(ref.authority.startsWith("zcode.cua/open-frame"));
  assert.ok(ref.frameId.length > 0);
  assert.equal(ref.contentProtection, "official_cua_frame_v1");
  assert.equal(ref.width, 2560);
  assert.equal(ref.height, 1440);
  assert.ok(Object.keys(result._meta).includes("zcode.cua/official-frame-integrity-v1"));
  assert.ok(!("isError" in result));
  assert.deepEqual(driver.calls, [{ name: "screenshot" }]);
});

test("矩阵2：指针/输入动作的归一化参数逐一下发到驱动", async () => {
  const driver = createMockDriver();
  const gate = createRecordingGate();
  const runtime = createComputerUseRuntimeWithDriver(driver, gate, {});

  const cases = [
    { toolName: "move", arguments: { x: 10, y: 20 } },
    { toolName: "click", arguments: { x: 1, y: 2 } },
    { toolName: "click", arguments: { x: 1, y: 2, button: "right" } },
    { toolName: "double_click", arguments: { x: 3, y: 4, button: "middle" } },
    { toolName: "drag", arguments: { fromX: 1, fromY: 2, toX: 30, toY: 40, button: "left" } },
    { toolName: "type", arguments: { text: "hello 你好" } },
    { toolName: "key", arguments: { key: "enter" } },
    { toolName: "scroll", arguments: { direction: "down", amount: 3 } },
  ];
  for (const input of cases) {
    const result = await runtime.execute({ ...input, context: mainContext() });
    assert.deepEqual(result, { content: [] }, input.toolName);
  }

  assert.deepEqual(
    driver.calls.map((call) => call.name),
    ["move", "click", "click", "doubleClick", "drag", "type", "key", "scroll"],
  );
  assert.deepEqual(driver.calls[0].input, { x: 10, y: 20 });
  // button 缺省归一为 "left"
  assert.deepEqual(driver.calls[1].input, { x: 1, y: 2, button: "left" });
  assert.deepEqual(driver.calls[2].input, { x: 1, y: 2, button: "right" });
  assert.deepEqual(driver.calls[3].input, { x: 3, y: 4, button: "middle" });
  assert.deepEqual(driver.calls[4].input, {
    fromX: 1,
    fromY: 2,
    toX: 30,
    toY: 40,
    button: "left",
  });
  assert.deepEqual(driver.calls[5].input, { text: "hello 你好" });
  // key 词表映射发生在真实驱动内部；runtime 下发原始键名
  assert.deepEqual(driver.calls[6].input, { key: "enter" });
  assert.deepEqual(driver.calls[7].input, { direction: "down", amount: 3 });
  // screenshot 允许缺省与空对象两种 arguments
  assert.equal(gate.state.authorizeCalls, 8);
});

test("矩阵3：权限门拒绝（无凭据 / ensure 失败）→ 失败形状，驱动零调用，不抛异常", async () => {
  const noCredentialDriver = createMockDriver();
  const noCredentialRuntime = createComputerUseRuntimeWithDriver(
    noCredentialDriver,
    createBrokerPermissionGate({}),
    {},
  );
  assertUnavailable(
    await noCredentialRuntime.execute({
      toolName: "click",
      arguments: { x: 1, y: 2 },
      context: mainContext(),
    }),
  );
  // 空白 socketPath 同样视为无凭据；refreshMarkerPath/env 不参与判定
  const blankRuntime = createComputerUseRuntimeWithDriver(
    createMockDriver(),
    createBrokerPermissionGate({ brokerSocketPath: "   ", refreshMarkerPath: "/marker" }),
    {},
  );
  assertUnavailable(
    await blankRuntime.execute({
      toolName: "click",
      arguments: { x: 1, y: 2 },
      context: mainContext(),
    }),
  );
  assert.equal(noCredentialDriver.calls.length, 0);

  let ensureCalls = 0;
  const rejectingRuntime = createComputerUseRuntimeWithDriver(
    createMockDriver(),
    createBrokerPermissionGate({
      brokerSocketPath: "/socket",
      ensureBrokerAvailable: async () => {
        ensureCalls += 1;
        throw new Error("broker down");
      },
    }),
    {},
  );
  assertUnavailable(
    await rejectingRuntime.execute({
      toolName: "click",
      arguments: { x: 1, y: 2 },
      context: mainContext(),
    }),
  );
  assert.equal(ensureCalls, 1);

  // 凭据 + ensure resolve → 放行
  const okDriver = createMockDriver();
  const okRuntime = createComputerUseRuntimeWithDriver(
    okDriver,
    createBrokerPermissionGate({
      brokerSocketPath: "/socket",
      ensureBrokerAvailable: async () => {},
    }),
    {},
  );
  assert.deepEqual(
    await okRuntime.execute({
      toolName: "move",
      arguments: { x: 0, y: 0 },
      context: mainContext(),
    }),
    { content: [] },
  );
  assert.equal(okDriver.calls.length, 1);
});

test("矩阵3：门结论不缓存——同一 runtime 每次 execute 都重新过门", async () => {
  const gate = createRecordingGate();
  const runtime = createComputerUseRuntimeWithDriver(createMockDriver(), gate, {});
  for (let i = 0; i < 3; i += 1) {
    await runtime.execute({ toolName: "move", arguments: { x: i, y: 0 }, context: mainContext() });
  }
  assert.equal(gate.state.authorizeCalls, 3);
  gate.state.granted = false;
  assertUnavailable(
    await runtime.execute({ toolName: "move", arguments: { x: 9, y: 9 }, context: mainContext() }),
  );
});

test("矩阵4：驱动动作抛错（模拟 addon 缺失/动态 import 失败）→ 失败形状 + warn 日志，进程不 crash", async () => {
  const warnings = [];
  const driver = createMockDriver();
  driver.click = async () => {
    throw new Error("libnut.node missing");
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {
    logger: { warn: (message, meta) => warnings.push({ message, meta }) },
  });
  assertUnavailable(
    await runtime.execute({
      toolName: "click",
      arguments: { x: 1, y: 2 },
      context: mainContext(),
    }),
  );
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.event, "zcode_cua.runtime.driver_failed");
  // 后续调用仍可用（失败被折进返回值，不损坏 runtime）
  assert.deepEqual(
    await runtime.execute({ toolName: "move", arguments: { x: 1, y: 1 }, context: mainContext() }),
    { content: [] },
  );
});

test("矩阵5：未登记 toolName（含 producer 面）→ 失败形状，gate 与驱动零调用", async () => {
  const driver = createMockDriver();
  const gate = createRecordingGate();
  const runtime = createComputerUseRuntimeWithDriver(driver, gate, {});
  for (const toolName of [
    "get_app_state",
    "list_apps",
    "list_windows",
    "capture_app",
    "bogus",
    "",
  ]) {
    assertUnavailable(await runtime.execute({ toolName, context: mainContext() }), toolName);
  }
  assert.equal(gate.state.authorizeCalls, 0);
  assert.equal(driver.calls.length, 0);
});

test("矩阵6：subagent 请求 → 失败形状，gate 与驱动零调用", async () => {
  const driver = createMockDriver();
  const gate = createRecordingGate();
  const runtime = createComputerUseRuntimeWithDriver(driver, gate, {});
  assertUnavailable(
    await runtime.execute({
      toolName: "screenshot",
      context: mainContext({ runtimeScope: "subagent" }),
    }),
  );
  assert.equal(gate.state.authorizeCalls, 0);
  assert.equal(driver.calls.length, 0);
});

test("矩阵7：dispose 之后一切动作失败；dispose 与 closeSession 幂等", async () => {
  const driver = createMockDriver();
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  await runtime.dispose();
  assertUnavailable(
    await runtime.execute({
      toolName: "screenshot",
      arguments: {},
      context: mainContext(),
    }),
  );
  await runtime.dispose(); // 幂等
  await runtime.closeSession(mainContext()); // dispose 后安全
  assert.equal(actionCalls(driver).length, 0);
  // dispose 已下发给驱动且只下发一次
  assert.equal(driver.calls.filter((call) => call.name === "dispose").length, 1);
});

test("矩阵7：dispose 排空排队调用；在途调用自然结束后也以失败形状返回（副作用不回滚），runtime 不再受理新调用", async () => {
  const driver = createMockDriver();
  const release = deferred();
  driver.click = async (input) => {
    driver.calls.push({ name: "click", input });
    await release.promise;
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const first = runtime.execute({
    toolName: "click",
    arguments: { x: 1, y: 1 },
    context: mainContext(),
  });
  const second = runtime.execute({
    toolName: "click",
    arguments: { x: 2, y: 2 },
    context: mainContext(),
  });
  await waitForDriverDispatch(driver);
  await runtime.dispose();
  // 排队中的第二个调用立即失败；在途的第一个不被取消（nut-js 动作不可中止），
  // 但按 spec「dispose 之后」语义同样以失败形状返回，不向调用方报成功
  assertUnavailable(await second);
  release.resolve();
  assertUnavailable(await first);
  // 驱动动作确实已下发执行过（副作用发生），只是结果被 dispose 语义折成失败形状
  assert.equal(actionCalls(driver).length, 1);
});

test("矩阵8：signal 调用前已中止 → 失败形状，驱动零调用", async () => {
  const driver = createMockDriver();
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const controller = new AbortController();
  controller.abort();
  assertUnavailable(
    await runtime.execute({
      toolName: "screenshot",
      context: mainContext(),
      signal: controller.signal,
    }),
  );
  assert.equal(driver.calls.length, 0);
});

test("矩阵8：排队中 signal 中止 → 立即返回失败形状且永不下发驱动", async () => {
  const driver = createMockDriver();
  const release = deferred();
  driver.click = async (input) => {
    driver.calls.push({ name: "click", input });
    await release.promise;
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const first = runtime.execute({
    toolName: "click",
    arguments: { x: 1, y: 1 },
    context: mainContext(),
  });
  const controller = new AbortController();
  const second = runtime.execute({
    toolName: "click",
    arguments: { x: 2, y: 2 },
    context: mainContext({ sessionId: "session-2" }),
    signal: controller.signal,
  });
  // 等第一个调用真正进入驱动执行，第二个处于排队中
  await waitForDriverDispatch(driver);
  controller.abort();
  // 不等待第一个调用结束即返回（不悬挂）
  assertUnavailable(await second);
  release.resolve();
  // 在途的第一个不受中止影响（其 signal 未被中止），正常完成
  assert.deepEqual(await first, { content: [] });
  assert.equal(driver.calls.length, 1);
  assert.deepEqual(driver.calls[0].input, { x: 1, y: 1, button: "left" });
});

test("矩阵8：执行中 signal 中止 → 驱动动作自然结束后才以失败形状返回（副作用不回滚）", async () => {
  const driver = createMockDriver();
  const release = deferred();
  let sideEffectEmitted = false;
  driver.click = async (input) => {
    driver.calls.push({ name: "click", input });
    await release.promise;
    sideEffectEmitted = true;
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const controller = new AbortController();
  const pending = runtime.execute({
    toolName: "click",
    arguments: { x: 5, y: 5 },
    context: mainContext(),
    signal: controller.signal,
  });
  await waitForDriverDispatch(driver);
  controller.abort();
  // spec 时序语义：执行中中止不提前 settle——驱动动作自然结束前，调用方拿不到结果
  const raced = await Promise.race([
    pending.then(() => "settled"),
    Promise.resolve("still-pending"),
  ]);
  assert.equal(raced, "still-pending");
  release.resolve();
  assertUnavailable(await pending);
  // 已下发的动作照常完成，副作用不被撤销
  assert.ok(sideEffectEmitted);
});

test("矩阵9：并发 execute 的驱动调用严格串行，各自拿到结果", async () => {
  const driver = createMockDriver();
  const timeline = [];
  driver.screenshot = async () => {
    timeline.push("shot:start");
    await new Promise((done) => setTimeout(done, 5));
    timeline.push("shot:end");
    return { data: "c2hvdA==", mimeType: "image/png", width: 2560, height: 1440 };
  };
  driver.type = async (input) => {
    timeline.push(`type(${input.text}):start`);
    await new Promise((done) => setTimeout(done, 5));
    timeline.push("type:end");
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const results = await Promise.all([
    runtime.execute({ toolName: "screenshot", context: mainContext() }),
    runtime.execute({ toolName: "type", arguments: { text: "a" }, context: mainContext() }),
    runtime.execute({ toolName: "type", arguments: { text: "b" }, context: mainContext() }),
  ]);
  assert.deepEqual(results[0].content[0], {
    type: "image",
    data: "c2hvdA==",
    mimeType: "image/png",
  });
  assert.deepEqual(results[1], { content: [] });
  assert.deepEqual(results[2], { content: [] });
  // 严格串行：偶数下标是 start、奇数下标是 end——任何 start 前一个动作必须已 end
  assert.equal(timeline.length, 6, timeline.join(" | "));
  for (let i = 0; i < timeline.length; i += 1) {
    const isStart = timeline[i].includes(":start");
    assert.equal(isStart, i % 2 === 0, timeline.join(" | "));
  }
});

test("矩阵10：closeSession 排空该会话排队调用，其它会话不受影响，驱动不释放", async () => {
  const driver = createMockDriver();
  const release = deferred();
  driver.click = async (input) => {
    driver.calls.push({ name: "click", input });
    await release.promise;
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  const inFlight = runtime.execute({
    toolName: "click",
    arguments: { x: 1, y: 1 },
    context: mainContext({ sessionId: "A" }),
  });
  const queuedA = runtime.execute({
    toolName: "click",
    arguments: { x: 2, y: 2 },
    context: mainContext({ sessionId: "A" }),
  });
  const queuedB = runtime.execute({
    toolName: "click",
    arguments: { x: 3, y: 3 },
    context: mainContext({ sessionId: "B" }),
  });
  await waitForDriverDispatch(driver);
  await runtime.closeSession(mainContext({ sessionId: "A" }));
  await runtime.closeSession(mainContext({ sessionId: "A" })); // 幂等
  await runtime.closeSession(mainContext({ sessionId: "unknown" })); // 未知会话安全
  assertUnavailable(await queuedA);
  release.resolve();
  // 在途调用不被 closeSession 取消（nut-js 动作不可中止），自然成功结束
  assert.deepEqual(await inFlight, { content: [] });
  assert.deepEqual(await queuedB, { content: [] });
  // 共享驱动未释放：后续调用照常
  assert.deepEqual(
    await runtime.execute({
      toolName: "move",
      arguments: { x: 0, y: 0 },
      context: mainContext({ sessionId: "B" }),
    }),
    { content: [] },
  );
  await runtime.dispose();
});

test("矩阵10：closeSession 排空时落 warn（spec 第四个 warn 点），未排空不落", async () => {
  const warnings = [];
  const logger = {
    warn: (message, meta) => warnings.push({ message, meta }),
  };
  const driver = createMockDriver();
  const release = deferred();
  driver.click = async (input) => {
    driver.calls.push({ name: "click", input });
    await release.promise;
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), { logger });
  const inFlight = runtime.execute({
    toolName: "click",
    arguments: { x: 1, y: 1 },
    context: mainContext({ sessionId: "A" }),
  });
  const queuedA = runtime.execute({
    toolName: "click",
    arguments: { x: 2, y: 2 },
    context: mainContext({ sessionId: "A" }),
  });
  await waitForDriverDispatch(driver);
  await runtime.closeSession(mainContext({ sessionId: "A" }));
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].meta.event, "zcode_cua.runtime.session_queued_drained");
  assert.equal(warnings[0].meta.drained, 1);
  // 无排队调用的 closeSession 不落 warn
  await runtime.closeSession(mainContext({ sessionId: "B" }));
  assert.equal(warnings.length, 1);
  assertUnavailable(await queuedA);
  release.resolve();
  await inFlight;
  await runtime.dispose();
});

test("入参契约：非法参数一律失败形状，gate 与驱动零调用", async () => {
  const driver = createMockDriver();
  const gate = createRecordingGate();
  const runtime = createComputerUseRuntimeWithDriver(driver, gate, {});
  const invalid = [
    { toolName: "click", arguments: { y: 2 } },
    { toolName: "click", arguments: { x: 1.5, y: 2 } },
    { toolName: "click", arguments: { x: "1", y: 2 } },
    { toolName: "click", arguments: { x: 1, y: 2, button: "left", extra: 1 } },
    { toolName: "click", arguments: { x: 1, y: 2, button: "leftclick" } },
    { toolName: "move", arguments: { x: Number.MAX_SAFE_INTEGER + 1, y: 0 } },
    { toolName: "drag", arguments: { fromX: 1, fromY: 2, toX: 3 } },
    { toolName: "type", arguments: {} },
    { toolName: "type", arguments: { text: 42 } },
    { toolName: "scroll", arguments: { direction: "sideways", amount: 1 } },
    { toolName: "scroll", arguments: { direction: "down", amount: 0 } },
    { toolName: "scroll", arguments: { direction: "down", amount: -1 } },
    { toolName: "screenshot", arguments: { extra: true } },
    { toolName: "screenshot", arguments: [1, 2] },
    { toolName: "screenshot", arguments: "empty" },
  ];
  for (const input of invalid) {
    assertUnavailable(
      await runtime.execute({ ...input, context: mainContext() }),
      JSON.stringify(input),
    );
  }
  assert.equal(gate.state.authorizeCalls, 0);
  assert.equal(driver.calls.length, 0);
});

test("键名词表外的取值：未注入谓词时由驱动侧拒绝（模拟真实驱动校验）→ 失败形状", async () => {
  const driver = createMockDriver();
  driver.key = async (input) => {
    if (!resolveNutKeyName(input.key)) throw new Error(`unknown key: ${input.key}`);
    driver.calls.push({ name: "key", input });
  };
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  assertUnavailable(
    await runtime.execute({
      toolName: "key",
      arguments: { key: "ctrl+c" },
      context: mainContext(),
    }),
  );
  // 词表内的键名正常下发
  assert.deepEqual(
    await runtime.execute({
      toolName: "key",
      arguments: { key: "escape" },
      context: mainContext(),
    }),
    { content: [] },
  );
  assert.deepEqual(driver.calls, [{ name: "key", input: { key: "escape" } }]);
});

test("键名词表外的取值：注入谓词后在廉价预检失败——gate 与驱动零调用、不入队", async () => {
  const driver = createMockDriver();
  const gate = createRecordingGate();
  const runtime = createComputerUseRuntimeWithDriver(driver, gate, {
    isKnownKeyName: (name) => resolveNutKeyName(name) !== undefined,
  });
  for (const key of ["ctrl+c", "", "ESCAPE", "无效"]) {
    assertUnavailable(
      await runtime.execute({ toolName: "key", arguments: { key }, context: mainContext() }),
      JSON.stringify(key),
    );
  }
  assert.equal(gate.state.authorizeCalls, 0);
  assert.equal(driver.calls.length, 0);
  // 词表内键名照常放行
  assert.deepEqual(
    await runtime.execute({ toolName: "key", arguments: { key: "enter" }, context: mainContext() }),
    { content: [] },
  );
  assert.equal(gate.state.authorizeCalls, 1);
});

test("入参契约：screenshot 接受缺省与空对象 arguments", async () => {
  const driver = createMockDriver();
  const runtime = createComputerUseRuntimeWithDriver(driver, createRecordingGate(), {});
  assert.ok(
    !("isError" in (await runtime.execute({ toolName: "screenshot", context: mainContext() }))),
  );
  assert.ok(
    !(
      "isError" in
      (await runtime.execute({ toolName: "screenshot", arguments: {}, context: mainContext() }))
    ),
  );
  assert.equal(driver.calls.length, 2);
});

test("键名词表映射（真实驱动的纯函数，大小写敏感）", () => {
  assert.equal(resolveNutKeyName("enter"), "Enter");
  // spec 词表是小写；大写/混合取值非法
  assert.equal(resolveNutKeyName("ESCAPE"), undefined);
  assert.equal(resolveNutKeyName("Escape"), undefined);
  assert.equal(resolveNutKeyName("a"), "A");
  assert.equal(resolveNutKeyName("Z"), undefined);
  assert.equal(resolveNutKeyName("5"), "Num5");
  assert.equal(resolveNutKeyName("0"), "Num0");
  assert.equal(resolveNutKeyName("f1"), "F1");
  assert.equal(resolveNutKeyName("f24"), "F24");
  assert.equal(resolveNutKeyName("pageup"), "PageUp");
  assert.equal(resolveNutKeyName("leftbracket"), "LeftBracket");
  // 词表外：组合键/修饰键/未知键拒绝
  assert.equal(resolveNutKeyName("ctrl"), undefined);
  assert.equal(resolveNutKeyName("command"), undefined);
  assert.equal(resolveNutKeyName(""), undefined);
  assert.equal(resolveNutKeyName("无效"), undefined);
  assert.equal(resolveNutKeyName(42), undefined);
});

test("DPI 换算：raster 像素 → nut-js 逻辑屏幕坐标", () => {
  // 真机证据（Windows 150%）：逻辑 1707x960，物理光栅 2560x1440
  const scale = computePointerScale(1707, 960, 2560, 1440);
  assert.deepEqual(toLogicalPoint(scale, 1280, 720), { x: 854, y: 480 });
  assert.deepEqual(toLogicalPoint(scale, 0, 0), { x: 0, y: 0 });
  // 尚无截图（scale=1）时恒等
  assert.deepEqual(toLogicalPoint({ x: 1, y: 1 }, 123, 456), { x: 123, y: 456 });
  // 非法尺寸退回 1:1，不抛错
  assert.deepEqual(computePointerScale(0, 0, 2560, 1440), { x: 1, y: 1 });
  assert.deepEqual(computePointerScale(1707, 960, Number.NaN, 1440), { x: 1, y: 1 });
});

test("PNG 编码器：签名/IHDR/IDAT 结构与像素 roundtrip", () => {
  const rgb = Buffer.from([
    255,
    0,
    0,
    0,
    255,
    0,
    0,
    0,
    255,
    255,
    255,
    255, // 2x2：红 绿 蓝 白
  ]);
  const png = encodeRgbPng(2, 2, rgb);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  // 遍历 chunk：IHDR(colortype 2, 8bit) + IDAT(inflate == filter0 扫描行) + IEND
  const chunks = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    chunks.push({ type, data: png.subarray(offset + 8, offset + 8 + length) });
    offset += 12 + length;
  }
  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ["IHDR", "IDAT", "IEND"],
  );
  assert.equal(chunks[0].data.readUInt32BE(0), 2);
  assert.equal(chunks[0].data.readUInt32BE(4), 2);
  assert.equal(chunks[0].data[8], 8);
  assert.equal(chunks[0].data[9], 2);
  const raw = inflateSync(chunks[1].data);
  const expected = Buffer.concat(
    [rgb.subarray(0, 6), rgb.subarray(6, 12)].map((row) => Buffer.concat([Buffer.from([0]), row])),
  );
  assert.deepEqual(raw, expected);
  assertThrows(() => encodeRgbPng(2, 2, Buffer.alloc(1)));
  assertThrows(() => encodeRgbPng(0, 2, Buffer.alloc(0)));
});

function assertThrows(fn) {
  assert.throws(fn, Error);
}
