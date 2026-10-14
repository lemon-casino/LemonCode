import assert from "node:assert/strict";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { openMacUpdateDmgAfterExit } from "./macUpdateInstall.js";

function createChild() {
  const events: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    unref: () => events.push("unref"),
    kill: () => {
      events.push("kill");
      return true;
    },
  });
  return { child: child as unknown as ChildProcess, events };
}

test("系统 helper 启动成功后才退出；DMG 路径通过独立参数传递", async () => {
  const { child, events } = createChild();
  const dmgPath = join(tmpdir(), "LCode's $(literal) 更新.dmg");
  let command: string | undefined;
  let args: string[] = [];
  let options: SpawnOptions | undefined;
  const handoff = openMacUpdateDmgAfterExit({
    dmgPath,
    ownerPid: 12345,
    exitApp: () => events.push("exit"),
    spawnProcess: (file, parameters, spawnOptions) => {
      command = file;
      args = parameters;
      options = spawnOptions;
      return child;
    },
  });
  assert.deepEqual(events, []);
  child.emit("spawn");
  await handoff;
  assert.equal(command, "/bin/sh");
  assert.deepEqual(args.slice(2), ["lcode-mac-update", "12345", dmgPath, "/usr/bin/open"]);
  assert.equal(args[1]?.includes(dmgPath), false);
  assert.equal(options?.detached, true);
  assert.equal(options?.stdio, "ignore");
  assert.deepEqual(events, ["unref", "exit"]);
});

test("helper 启动失败保持旧 Main 存活并返回可重试错误", async () => {
  const { child, events } = createChild();
  const failure = new Error("spawn /bin/sh EACCES");
  const handoff = openMacUpdateDmgAfterExit({
    dmgPath: join(tmpdir(), "LCode.dmg"),
    ownerPid: 12345,
    exitApp: () => events.push("exit"),
    spawnProcess: () => child,
  });
  child.emit("error", failure);
  await assert.rejects(handoff, failure);
  assert.deepEqual(events, []);
});

test("退出入口失败时撤销本次 helper，避免以后普通退出误打开 DMG", async () => {
  const { child, events } = createChild();
  const failure = new Error("exit failed");
  const handoff = openMacUpdateDmgAfterExit({
    dmgPath: join(tmpdir(), "LCode.dmg"),
    ownerPid: 12345,
    exitApp: () => {
      throw failure;
    },
    spawnProcess: () => child,
  });
  child.emit("spawn");
  await assert.rejects(handoff, failure);
  assert.deepEqual(events, ["unref", "kill"]);
});

test("真实系统进程在旧 owner 退出后才打开 DMG，保留路径原值", { timeout: 10_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-mac-update-"));
  const owner = spawn(
    "bash",
    ["--noprofile", "--norc", "-c", 'printf "%s\\n" "$$"; read -r release'],
    {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  let helper: ChildProcess | undefined;
  t.after(async () => {
    owner.kill();
    helper?.kill();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  });
  await once(owner, "spawn");
  const [pidLine] = await once(owner.stdout, "data");
  const ownerPid = Number(String(pidLine).trim());
  assert.ok(Number.isSafeInteger(ownerPid) && ownerPid > 0);
  const opener = join(directory, "open-fixture.sh");
  await writeFile(
    opener,
    '#!/bin/sh\nif kill -0 "$LCODE_TEST_OWNER_PID" 2>/dev/null; then exit 8; fi\nprintf "%s" "$1"\n',
    { mode: 0o700 },
  );
  const shellPath = (path: string) =>
    path
      .replaceAll("\\", "/")
      .replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  const dmgPath = join(directory, "LCode's $(literal) 更新.dmg");
  let openedPath = "";
  let exitRequested = false;
  let helperExit: Promise<unknown[]> | undefined;
  await openMacUpdateDmgAfterExit({
    dmgPath,
    ownerPid,
    exitApp: () => {
      exitRequested = true;
    },
    spawnProcess: (_file, args) => {
      const testArgs = [...args];
      testArgs[5] = shellPath(opener);
      helper = spawn("bash", testArgs, {
        env: { ...process.env, LCODE_TEST_OWNER_PID: String(ownerPid) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      helper.stdout?.on("data", (chunk: Buffer) => {
        openedPath += chunk.toString();
      });
      helperExit = once(helper, "close");
      return helper;
    },
  });
  assert.equal(exitRequested, true);
  await delay(150);
  assert.equal(openedPath, "", "旧 owner 仍存活时不能打开安装镜像");
  const ownerExit = once(owner, "close");
  owner.stdin.end("exit\n");
  await ownerExit;
  assert.deepEqual(await helperExit, [0, null]);
  assert.equal(openedPath, dmgPath);
});
