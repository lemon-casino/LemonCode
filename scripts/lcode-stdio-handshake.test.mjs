// stdio 握手往返端到端测试（品牌迁移后 wire 值 lcode-hello/lcode-hello-ack 的真实进程验证）
// 同时覆盖：services 迁移接线（entry-stdio 首行）、LCODE_DATA_BASE_DIR 旧名 ZCODE_DATA_BASE_DIR 回退。
//
// 边界说明：直接运行 tsc 产物时，初始化会在 "未嵌入 LCode Built-in Provider Config" 处 fatal——
// built-in provider config 是打包期 define 注入的（build-remote/打包流程），与品牌迁移无关的既有设计。
// 因此本测试验证到「握手完成 + ack 被 schema 校验接受（client connected 日志）」为止。
//
// 运行：npx tsx --test scripts/lcode-stdio-handshake.test.mjs
// 前置：pnpm build（需要 packages/server/dist/entry-stdio.js）
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(repoRoot, "packages/server/dist/entry-stdio.js");

function runHandshake({ dataBaseDirEnv }) {
  return new Promise((resolveTest, rejectTest) => {
    // server 产物经 workspace exports 直接引用 TS 源，需要 tsx loader 解析 .js→.ts
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        // 故意只用旧名环境变量：验证 services getDataBaseDir 的旧名回退仍在生效。
        ZCODE_DATA_BASE_DIR: dataBaseDirEnv,
        LCODE_DATA_BASE_DIR: "",
        LCODE_TELEMETRY: "false",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    let settled = false;
    let ackSent = false;
    let helloFrame = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {}
      fn(value);
    };
    const timer = setTimeout(() => {
      finish(rejectTest, new Error(`handshake timeout; stdout=${stdout.slice(0, 400)} stderr=${stderr.slice(-1500)}`));
    }, 30_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(rejectTest, err);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (ackSent) return;
      const newline = stdout.indexOf("\n");
      if (newline === -1) return;
      ackSent = true;
      clearTimeout(timer);
      const helloLine = stdout.slice(0, newline).trim();
      try {
        helloFrame = JSON.parse(helloLine);
      } catch {
        finish(rejectTest, new Error(`stdout 首行不是合法 JSON：${helloLine.slice(0, 200)}`));
        return;
      }
      // hello 之后 stdout 只允许 RPC 帧；出现任何非 JSON 都算协议污染
      for (const line of stdout.slice(newline + 1).split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          JSON.parse(trimmed);
        } catch {
          finish(rejectTest, new Error(`握手后 stdout 出现非 RPC 帧：${trimmed.slice(0, 200)}`));
          return;
        }
      }
      // Phase 2: 回 hello-ack（客户端角色）
      child.stdin.write(
        `${JSON.stringify({ type: "lcode-hello-ack", version: "smoke-test", clientId: "lcode-brand-check" })}\n`,
      );
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (!ackSent || settled) return;
      if (stderr.includes("client connected")) {
        clearTimeout(timer);
        finish(resolveTest, { stderr, helloFrame });
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (!settled) {
        finish(resolveTest, { stderr, helloFrame, exitCode: code });
      }
    });
  });
}

test("stdio 握手往返：server 发合法 lcode-hello，ack 被 schema 校验接受", async () => {
  assert.ok(existsSync(entry), `缺少 server 产物 ${entry}，先 pnpm build`);
  const dataRoot = await mkdtemp(join(tmpdir(), "lcode-handshake-"));
  try {
    const { stderr, helloFrame } = await runHandshake({ dataBaseDirEnv: dataRoot });
    // hello 帧必须是改名后的 wire 值与结构
    assert.ok(helloFrame, `未收到 hello；stderr=${stderr.slice(-1200)}`);
    assert.equal(helloFrame.type, "lcode-hello");
    assert.equal(typeof helloFrame.version, "string");
    assert.ok(helloFrame.version.length > 0);
    assert.equal(helloFrame.platform, process.platform);
    assert.equal(helloFrame.arch, process.arch);
    assert.equal(typeof helloFrame.pid, "number");
    // ack 被 zod schema 接受（改名后的 lcode-hello-ack literal 校验通过）
    assert.match(stderr, /client connected: lcode-brand-check/, `ack 未被接受；stderr=${stderr.slice(-1200)}`);
    assert.doesNotMatch(stderr, /Invalid hello-ack|Failed to parse hello-ack/);
    assert.ok(stderr.includes("lcode-server:stdio"), "log 前缀缺失");
    // 旧名回退生效：进程按 ZCODE_DATA_BASE_DIR 指向的目录初始化（启动阶段无 fatal 路径错误）
    assert.doesNotMatch(stderr, /ENOENT.*lcode|EPERM/);
  } finally {
    await rm(dataRoot, { recursive: true, force: true });
  }
});
