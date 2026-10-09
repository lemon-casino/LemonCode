import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NodeExecutionAdapter } from "./node-execution-adapter.js";

test(
  "Bash root completion settles an escaped HTTP server before releasing its checkout",
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-bash-descendants-"));
    const marker = join(root, "ready.json");
    const adapter = new NodeExecutionAdapter({ outputRootDir: join(root, "output") });
    const worker = `const fs=require('node:fs');const http=require('node:http');const s=http.createServer((req,res)=>{if(req.url==='/stop')res.on('finish',()=>process.exit(0));res.end('owned');});s.listen(0,'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({port:s.address().port,pid:process.pid})));`;
    const encoded = Buffer.from(worker).toString("base64");
    const node = process.execPath.replaceAll("\\", "/");
    const ready = marker.replaceAll("\\", "/");
    let url: string | undefined;
    try {
      const result = await adapter.run({
        command: {
          mode: "shell",
          shellProfile: "posix-bash",
          // 根 shell 返回，服务隐藏在子 shell 内；复现真实遗漏，不能仅测仍活着的父进程。
          command: `("${node}" -e "eval(Buffer.from('${encoded}','base64').toString())" >/dev/null 2>&1 &)\nwhile [ ! -f "${ready}" ]; do sleep 0.02; done\necho root-completed`,
        },
        cwd: root,
        timeoutMs: 10000,
      });
      assert.equal(result.status, "completed", result.error?.message);
      const server = JSON.parse(await readFile(marker, "utf8")) as { port: number };
      url = `http://127.0.0.1:${server.port}`;
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout.text, /root-completed/);
      await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }));
      await adapter.close();
      await rm(root, { recursive: true });
    } finally {
      // 红灯时通过夹具自身 HTTP 退出入口收尾，不能让回归测试留下新的后台服务。
      if (!url) {
        const server = await readFile(marker, "utf8")
          .then(JSON.parse)
          .catch(() => undefined);
        if (server) url = `http://127.0.0.1:${server.port}`;
      }
      if (url) await fetch(`${url}/stop`).catch(() => undefined);
      await adapter.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
);

test(
  "failed descendant cleanup remains owned across close retries and blocks new admission",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-bash-owner-retry-"));
    let unavailable = true;
    let attempts = 0;
    const adapter = new NodeExecutionAdapter({
      outputRootDir: root,
      bashProcessOwnerFactory: async () => ({
        attach: () => {},
        settle: async () => {
          attempts++;
          if (unavailable) throw new Error("exit verification unavailable");
        },
      }),
    });
    const request = {
      command: {
        mode: "shell" as const,
        shellProfile: "posix-bash" as const,
        command: "echo fixture",
      },
      cwd: root,
    };
    try {
      const result = await adapter.run(request);
      assert.equal(result.status, "failed");
      assert.match(result.error?.message ?? "", /exit verification/);
      assert.equal((await adapter.run(request)).status, "cancelled");
      await assert.rejects(adapter.close(), /exit verification/);
      assert.equal((await adapter.run(request)).status, "cancelled");
      await assert.rejects(adapter.start(request), /shutting down/);
      unavailable = false;
      await adapter.close();
      assert.equal(attempts, 3);
    } finally {
      unavailable = false;
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("short Bash commands retain output and nonzero exit status", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "lcode-bash-fast-exit-"));
  const adapter = new NodeExecutionAdapter({ outputRootDir: root });
  try {
    for (const code of [0, 7, 0, 9]) {
      const result = await adapter.run({
        command: {
          mode: "shell",
          shellProfile: "posix-bash",
          command: `echo fixture; exit ${code}`,
        },
        cwd: root,
      });
      assert.equal(result.exitCode, code, result.error?.message);
      assert.equal(result.status, code ? "failed" : "completed");
      assert.match(result.stdout.text, /fixture/);
    }
  } finally {
    await adapter.close();
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "close during OS owner preparation cancels admission and settles the prepared handle",
  { timeout: 15000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-bash-owner-admission-"));
    let prepared!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      prepared = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let settled = 0;
    const adapter = new NodeExecutionAdapter({
      outputRootDir: root,
      bashProcessOwnerFactory: async () => {
        prepared();
        await gate;
        return {
          attach: () => assert.fail("must not spawn after close"),
          settle: async () => {
            settled++;
          },
        };
      },
    });
    try {
      const running = adapter.run({
        command: {
          mode: "shell",
          shellProfile: "posix-bash",
          command: "echo unexpected > launched",
        },
        cwd: root,
      });
      await entered;
      const closing = adapter.close();
      release();
      assert.equal((await running).status, "cancelled");
      await closing;
      assert.equal(settled, 1);
      await assert.rejects(access(join(root, "launched")));
    } finally {
      release?.();
      await adapter.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
