import assert from "node:assert/strict";
import { chmod, lstat, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setImmediate as nextTurn, setTimeout as sleep } from "node:timers/promises";
import { test } from "node:test";
import { withFakeBackend, writeFixtureFile, WINDOWS_X64, type CommandInvocation } from "./toolBackend.fixture.js";

test("explicit wildcard freezes the maximum stable version from one remote query", async () => {
  await withFakeBackend(WINDOWS_X64, async ({ backend, commands }) => {
    assert.equal(await backend.resolveVersion({ key: "node", constraint: "*" }), "24.14.1");
    assert.equal(commands.filter((command) => command.args[1] === "ls-remote").length, 1);
  });
});

test("canonical OR ranges resolve once while empty constraints remain invalid", async () => {
  await withFakeBackend(WINDOWS_X64, async ({ backend, commands }) => {
    assert.equal(await backend.resolveVersion({ key: "node", constraint: ">=22.0.0 <23.0.0-0||>=24.0.0 <25.0.0-0" }), "24.14.1");
    await assert.rejects(backend.resolveVersion({ key: "node", constraint: "  " }), /constraint is empty/u);
    assert.equal(commands.filter((command) => command.args[1] === "ls-remote").length, 1);
  });
});

test("pnpm rejects missing or host Node paths before any tool installation", async () => {
  await withFakeBackend(WINDOWS_X64, async ({ backend, commands }) => {
    await assert.rejects(backend.installTool({ key: "pnpm", version: "10.33.2" }), /frozen.*nodePath|nodePath.*required/iu);
    await assert.rejects(backend.installTool({ key: "pnpm", version: "10.33.2", nodePath: process.execPath }), /managed|frozen/iu);
    assert.equal(commands.filter((command) => command.args[1] === "install").length, 0);
  });
});

test("pnpm cjs is verified by frozen Node even without an executable bit", async () => {
  await withFakeBackend({ platform: "linux", arch: "x64", libc: "glibc" }, async ({ backend, nodePath, pnpmRoot, commands }) => {
    const launcher = join(pnpmRoot, "bin/pnpm.cjs");
    await writeFixtureFile(launcher, "#!/usr/bin/env node\nconsole.log('10.33.2');\n");
    await chmod(launcher, 0o644);
    const result = await backend.installTool({ key: "pnpm", version: "10.33.2", nodePath });
    assert.equal(result.toolPath, launcher);
    const probe = commands.find((command) => command.executable === nodePath && command.args[0] === launcher);
    assert.ok(probe, "the cjs version probe must execute the supplied frozen Node");
    assert.equal(probe.options.env?.NODE_OPTIONS, undefined);
    assert.equal(probe.options.env?.NODE_PATH, undefined);
    const lookup = commands.find((command) => command.args[1] === "where");
    assert.ok(lookup?.options.env?.PATH?.startsWith(`${dirname(nodePath)}:`));
  });
});

test("Windows cmd launcher resolves its cjs payload without shell or host Node", async () => {
  await withFakeBackend(WINDOWS_X64, async ({ backend, nodePath, pnpmRoot, commands }) => {
    const launcher = join(pnpmRoot, "pnpm.cmd");
    const payload = join(pnpmRoot, "node_modules/pnpm/bin/pnpm.cjs");
    await writeFixtureFile(launcher, "@node \"%~dp0node_modules\\pnpm\\bin\\pnpm.cjs\" %*\r\n");
    await writeFixtureFile(payload, "console.log('10.33.2');\n");
    const result = await backend.installTool({ key: "pnpm", version: "10.33.2", nodePath });
    assert.equal(result.toolPath, payload);
    assert.ok(commands.some((command) => command.executable === nodePath && command.args[0] === payload));
    assert.ok(commands.every((command) => command.executable !== launcher && !command.options.shell));
  });
});

test("native pnpm version and cache lookup subprocesses get the frozen Node first on Windows PATH", async () => {
  await withFakeBackend(WINDOWS_X64, async ({ backend, nodePath, pnpmRoot, commands }) => {
    const launcher = join(pnpmRoot, "pnpm.exe");
    await writeFixtureFile(launcher, Buffer.from("MZtest-native-pnpm"));
    assert.equal((await backend.installTool({ key: "pnpm", version: "10.33.2", nodePath })).toolPath, launcher);
    const probe = commands.find((command) => command.executable === launcher);
    const lookup = commands.find((command) => command.args[1] === "where");
    for (const command of [probe, lookup]) {
      assert.equal(command?.options.env?.PATH?.split(";")[0], dirname(nodePath));
      assert.equal(command?.options.env?.Path, undefined);
      assert.equal(command?.options.env?.mIsE_CONFIG_DIR, undefined);
      assert.equal(command?.options.env?.NODE_OPTIONS, undefined);
    }
    assert.ok(commands.some((command) => command.executable === nodePath && command.args[0] === "--version"));
  });
});

test("cached tools are verified under the same-key lock without mise install", async () => {
  await withFakeBackend(WINDOWS_X64, async (fixture) => {
    const { backend, nodePath, pnpmRoot, commands, dataDir } = fixture;
    await writeFixtureFile(join(pnpmRoot, "pnpm.exe"), Buffer.from("MZtest-native-pnpm"));
    const lockPath = join(dataDir, "tool-store/mise/v2026.10.2/windows-x64/windows-x64-pnpm-10.33.2.lock.lock");
    const checked = Promise.withResolvers<void>();
    fixture.commandHandler = (command) => {
      if (command.args[1] === "install") {
        command.complete(new Error("cached install must not access the network"));
        command.close(1);
        return true;
      }
      if (command.args[1] !== "where") return false;
      void lstat(lockPath).then((entry) => {
        assert.equal(entry.isDirectory(), true);
        checked.resolve();
        command.complete(null, pnpmRoot);
        command.close();
      }).catch(checked.reject);
      return true;
    };
    assert.equal((await backend.installTool({ key: "pnpm", version: "10.33.2", nodePath })).toolPath, join(pnpmRoot, "pnpm.exe"));
    await checked.promise;
    assert.equal(commands.filter((command) => command.args[1] === "install").length, 0);
  });
});

test("invalid existing cache fails closed without downloading over it", async () => {
  await withFakeBackend(WINDOWS_X64, async ({ backend, nodePath, commands }) => {
    await assert.rejects(backend.installTool({ key: "pnpm", version: "10.33.2", nodePath }), /no supported pnpm executable/iu);
    assert.equal(commands.filter((command) => command.args[1] === "install").length, 0);
  });
});

test("cancelled installation keeps its lock until child close, then another consumer succeeds", async () => {
  await withFakeBackend(WINDOWS_X64, async (fixture) => {
    const { backend, nodePath, pnpmRoot } = fixture;
    await rm(pnpmRoot, { recursive: true, force: true });
    const started = Promise.withResolvers<CommandInvocation>();
    const aborted = Promise.withResolvers<void>();
    let installCalls = 0;
    fixture.commandHandler = (command) => {
      if (command.args[1] !== "install") return false;
      installCalls += 1;
      if (installCalls !== 1) {
        void writeFixtureFile(join(pnpmRoot, "pnpm.exe"), Buffer.from("MZtest-native-pnpm")).then(() => {
          command.complete();
          command.close();
        });
        return true;
      }
      command.options.signal?.addEventListener("abort", () => {
        command.complete(Object.assign(new Error("installation aborted"), { name: "AbortError", code: "ABORT_ERR" }));
        aborted.resolve();
      }, { once: true });
      started.resolve(command);
      return true;
    };
    const controller = new AbortController();
    let settled = false;
    const first = backend.installTool({ key: "pnpm", version: "10.33.2", nodePath, signal: controller.signal });
    const observed = first.then(() => { settled = true; }, () => { settled = true; });
    const active = await started.promise;
    controller.abort();
    await aborted.promise;
    await sleep(100);
    const settledBeforeClose = settled;
    const second = backend.installTool({ key: "pnpm", version: "10.33.2", nodePath });
    await nextTurn();
    const callsBeforeClose = installCalls;
    active.close(null);
    await assert.rejects(first, { name: "AbortError" });
    await observed;
    await second;
    assert.equal(settledBeforeClose, false, "AbortError alone is not proof the child exited");
    assert.equal(callsBeforeClose, 1, "the next consumer must not install before close");
    assert.equal(installCalls, 2);
  });
});
