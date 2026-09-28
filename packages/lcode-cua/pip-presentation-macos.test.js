import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { createMacOsPipPresenter } from "./pip-presentation-macos.js";

function fakeProcess(onCommand) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    if (!child.killed) {
      child.killed = true;
      queueMicrotask(() => {
        child.emit("exit", null, "SIGTERM");
        child.emit("close", null, "SIGTERM");
      });
    }
  };
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line) onCommand(child, JSON.parse(line));
    }
  });
  return child;
}

test("presenter waits for ready and command acknowledgements in order", async () => {
  const commands = [];
  const child = fakeProcess((process, command) => {
    commands.push(command);
    if (command.type === "close") {
      // 模拟 Node 先报告进程退出、随后才排空最后一个 stdout ACK 的真实时序。
      process.emit("exit", 0, null);
      queueMicrotask(() => {
        process.stdout.write(`${JSON.stringify({ id: command.id, type: "applied" })}\n`);
        queueMicrotask(() => process.emit("close", 0, null));
      });
      return;
    }
    process.stdout.write(`${JSON.stringify({ id: command.id, type: "applied" })}\n`);
  });
  const presenterPromise = createMacOsPipPresenter({
    executablePath: "/bundle/presenter",
    spawn: () => child,
    timeoutMs: 100,
  });
  child.stdout.write('{"type":"ready","version":1}\n');
  const presenter = await presenterPromise;
  await presenter.show({ data: "cG5n", width: 2, height: 1, title: "Editor" });
  await presenter.hide();
  await presenter.dispose();
  assert.deepEqual(
    commands.map(({ id: _id, ...command }) => command),
    [
      { type: "show", pngBase64: "cG5n", width: 2, height: 1, title: "Editor" },
      { type: "hide" },
      { type: "close" },
    ],
  );
});

test("presenter rejects a command when native side reports an error", async () => {
  const child = fakeProcess((process, command) => {
    process.stdout.write(
      `${JSON.stringify({ id: command.id, type: "error", error: "invalid png" })}\n`,
    );
  });
  const presenterPromise = createMacOsPipPresenter({
    executablePath: "/bundle/presenter",
    spawn: () => child,
    timeoutMs: 100,
  });
  child.stdout.write('{"type":"ready","version":1}\n');
  const presenter = await presenterPromise;
  await assert.rejects(presenter.show({ data: "bad", width: 1, height: 1 }), /rejected a command/u);
});

test("presenter fails closed on malformed ready frames and missing executable", async () => {
  await assert.rejects(createMacOsPipPresenter({ env: {} }), /executable is unavailable/u);
  const child = fakeProcess(() => {});
  const result = createMacOsPipPresenter({
    executablePath: "/bundle/presenter",
    spawn: () => child,
    timeoutMs: 100,
  });
  child.stdout.write('{"type":"ready","version":2}\n');
  await assert.rejects(result, /invalid ready frame/u);
  assert.equal(child.killed, true);
});
