import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import type { AppSettings } from "@lcode/shared";
import { createTerminalService } from "./terminalService.js";

// 真实平台能力验证，不用 mock 冒充 PTY；其余平台需各自实际 smoke 后才放行。
test(
  "Windows node-pty receives frozen PATH and releases only after PowerShell NoProfile exits",
  {
    skip: process.platform !== "win32",
    timeout: 30_000,
  },
  async (context) => {
    const hostEnvironment = { ...process.env };
    const nodePty = await import("node-pty");
    const shell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const frozenPath = [dirname(process.execPath), process.env.PATH]
      .filter(Boolean)
      .join(delimiter);
    let releases = 0;
    let observedExit = false;
    let spawned = false;
    const finished = Promise.withResolvers<void>();
    const marker = `PTY_SMOKE_${crypto.randomUUID().replaceAll("-", "")}`;
    let output = "";
    const service = createTerminalService({
      settingService: {
        async get() {
          return {
            terminalInheritSystemProfile: false,
            integratedTerminalShell: {
              mode: "shell",
              dialect: "powershell",
              id: "powershell",
              label: "PowerShell",
              path: shell,
            },
          } as AppSettings;
        },
      },
      runtimeEnvironment: {
        async acquire(request) {
          return {
            executionScope: { workspacePath: request.workspacePath },
            envOverlay: { set: { PATH: frozenPath, LCODE_TERMINAL_SMOKE: marker } },
            async release() {
              assert.equal(
                observedExit || !spawned,
                true,
                "consumer released before a real PTY exit",
              );
              releases += 1;
            },
          };
        },
      },
      async loadPty() {
        return {
          spawn(file, _args, options) {
            assert.equal(
              options?.env?.PATH === frozenPath,
              true,
              "PTY did not receive frozen PATH",
            );
            // 测试进程关闭用户 profile；生产仍保留原 Shell 选择，不改写任何 profile 文件。
            const pty = nodePty.spawn(file, ["-NoLogo", "-NoProfile"], options);
            spawned = true;
            pty.onExit(() => {
              observedExit = true;
            });
            return pty;
          },
        };
      },
    });
    const subscriptions: { dispose(): void }[] = [];
    let terminalId: string | undefined;
    try {
      const terminal = await service.create({
        cols: 200,
        rows: 30,
        cwd: tmpdir(),
        workspacePath: tmpdir(),
      });
      terminalId = terminal.id;
      subscriptions.push(
        service.onDynamicData(terminal.id)((data) => {
          output += data;
        }),
      );
      subscriptions.push(
        service.onDynamicExit(terminal.id)(() => {
          finished.resolve();
        }),
      );
      assert.equal(releases, 0);
      // 使用冻结 PATH 解析 node；只回显 execPath 与测试哨兵，不输出用户环境内容。
      await service.write({
        id: terminal.id,
        data: "node -p \"process.env.LCODE_TERMINAL_SMOKE+'='+process.execPath\"\r\nexit\r\n",
      });
      await finished.promise;
      await service.dispose({ id: terminal.id });
      const plain = stripVTControlCharacters(output);
      const actual = plain.match(new RegExp(`${marker}=([^\\r\\n]+)`))?.[1]?.trim();
      assert.equal(Boolean(actual), true, "NoProfile shell did not report the Node executable");
      assert.equal(
        resolve(actual!).toLowerCase(),
        resolve(process.execPath).toLowerCase(),
        "Node executable differs from frozen PATH; inspect shell PATH rewriting",
      );
      assert.equal(releases, 1);
      assert.equal(
        isDeepStrictEqual({ ...process.env }, hostEnvironment),
        true,
        "Host environment changed",
      );
      context.diagnostic(
        `real ConPTY: PowerShell -NoProfile -> node process.execPath=${actual}; release after exit=${releases}`,
      );
    } finally {
      for (const subscription of subscriptions) subscription.dispose();
      if (terminalId && !observedExit) void service.dispose({ id: terminalId }).catch(() => {});
      await service.disposeAllAndWait();
    }
  },
);
