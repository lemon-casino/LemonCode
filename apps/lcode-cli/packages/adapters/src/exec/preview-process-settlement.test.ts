import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeExecutionAdapterProcess } from "./node-execution-adapter-process.js";

class SettlementFixture extends NodeExecutionAdapterProcess {
  stop(child: ChildProcess) {
    return this.terminateProcessTree(child, true);
  }
  pendingCount() {
    return this.pendingBashProcessTreeKills.size;
  }
  handles() {
    return [...this.pendingBashProcessTreeKills.values()];
  }
  async initialized() {
    await this.shellInitRetentionCleanup;
  }
}

for (const platform of ["linux", "darwin"] as const) {
  test(
    `${platform}: Bash settlement waits for the final process-table lookup and keeps cleanup alive`,
    { timeout: 5000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "lcode-posix-settlement-"));
      const fixture = new SettlementFixture({ platform, outputRootDir: root });
      await fixture.initialized();
      const signals: [number, unknown][] = [];
      let firstLookup!: () => void;
      const firstSignal = new Promise<void>((resolve) => {
        firstLookup = resolve;
      });
      let secondLookup!: () => void;
      const finalLookupStarted = new Promise<void>((resolve) => {
        secondLookup = resolve;
      });
      let releaseFinalLookup!: () => void;
      let finishing = false;
      let completion: Promise<void> | void = undefined;
      let lookups = 0;
      t.mock.method(process, "kill", (pid: number, signal: unknown) => {
        signals.push([pid, signal]);
        if (pid === 10001 && signal === "SIGTERM") firstLookup();
        return true;
      });
      t.mock.method(childProcess, "spawn", (file: string, args: string[]) => {
        // 不发送真实 POSIX 信号：Windows 上同样验证两个平台分支及受控 ps 输出。
        assert.equal(file, "ps");
        assert.deepEqual(args, ["-A", "-o", "pid=", "-o", "ppid="]);
        const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
        const lookup = ++lookups;
        queueMicrotask(() => {
          child.stdout.emit("data", "10000 1\n10001 10000\n20001 20000\n");
          if (lookup === 1) child.emit("close", 0);
          else {
            releaseFinalLookup = () => child.emit("close", 0);
            secondLookup();
            if (finishing) releaseFinalLookup();
          }
        });
        return child as ChildProcess;
      });
      syncBuiltinESMExports();
      try {
        let settled = false;
        completion = fixture.stop({ pid: 10000 } as ChildProcess);
        assert.ok(completion instanceof Promise);
        void completion.then(() => {
          settled = true;
        });
        await firstSignal;
        assert.equal(settled, false);
        assert.equal(fixture.pendingCount(), 1);
        assert.equal((fixture.handles()[0] as NodeJS.Timeout).hasRef(), true);
        await finalLookupStarted;
        assert.equal(settled, false);
        releaseFinalLookup();
        await completion;
        assert.equal(fixture.pendingCount(), 0);
        assert.ok(signals.some(([pid, signal]) => pid === 10001 && signal === "SIGKILL"));
        assert.equal(
          signals.some(([pid]) => pid === 20001 || pid === 20000),
          false,
        );
      } finally {
        // 断言失败也要在恢复真实系统调用前结清测试杀树，避免遗留计时器误发真实信号。
        finishing = true;
        releaseFinalLookup?.();
        await completion;
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
