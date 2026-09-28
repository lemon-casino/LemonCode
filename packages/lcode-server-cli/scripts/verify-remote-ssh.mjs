#!/usr/bin/env node
/**
 * 远程验证编排：把 staged 发行包部署到带 sshd 的
 * Linux 容器里，从本机经 `ssh -L` 隧道验证 daemon 生命周期与 HTTP/WS ingress 合同。
 *
 * 用法：
 *   node scripts/verify-remote-ssh.mjs [--target linux-x64|linux-arm64] [--keep]
 *
 * 前置：docker 可用；已运行 `pnpm --filter @lcode/server-cli stage --target <target>`。
 * `--keep` 保留容器与隧道供手工调试（脚本会打印连接方式）。
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { dockerPlatformForTarget, resolveVerificationTarget } from "./verify-remote-ssh-target.mjs";

const HOST_CAPABILITY_HEADER = "x-lcode-rpc-host-capability";
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const target = resolveVerificationTarget(readArg("--target"));
const dockerPlatform = dockerPlatformForTarget(target);
const releaseArchive = join(packageRoot, "dist-release", `lcode-server-${target}.tar.gz`);
const containerName = `lcode-server-verify-${process.pid}`;
const imageTag = "lcode-server-verify-sshd:ubuntu22";

const log = (...args) => console.log("[verify-remote-ssh]", ...args);
const cleanups = [];

function readArg(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function run(command, args, { input, allowFailure = false, quiet = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0 || allowFailure) {
        resolvePromise({ code: code ?? 1, stdout, stderr });
      } else {
        if (!quiet) console.error(stderr || stdout);
        rejectPromise(new Error(`${command} ${args.join(" ")} exited with code ${code ?? "null"}`));
      }
    });
  });
}

async function findFreePort() {
  return await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePromise(port));
    });
  });
}

async function retry(description, attempts, delayMs, action) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
  throw new Error(`${description} failed after ${attempts} attempts: ${lastError}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function main() {
  await run("docker", ["version"], { quiet: true }).catch(() => {
    throw new Error("docker is not available");
  });
  await run("ls", [releaseArchive], { quiet: true }).catch(() => {
    throw new Error(
      `Release archive missing: ${releaseArchive}; run pnpm --filter @lcode/server-cli stage --target ${target}`,
    );
  });

  // 一次性 ssh 密钥，容器仅信任本次运行生成的公钥。
  const workDir = await mkdtemp(join(tmpdir(), "lcode-server-verify-"));
  cleanups.push(() => rm(workDir, { force: true, recursive: true }));
  const keyPath = join(workDir, "id_ed25519");
  await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", keyPath]);
  const { stdout: publicKey } = await run("cat", [`${keyPath}.pub`]);

  log(`build sshd image (${imageTag})`);
  const dockerfile = [
    "FROM ubuntu:22.04",
    "RUN apt-get update && apt-get install -y --no-install-recommends openssh-server ca-certificates && rm -rf /var/lib/apt/lists/*",
    "RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh",
    'CMD ["/usr/sbin/sshd", "-D", "-e"]',
  ].join("\n");
  // build context 用空的临时目录：Dockerfile 走 stdin，不需要任何文件，
  // 用包根会把 dist-release/node_modules 几百 MB 传给 docker daemon。
  await run("docker", ["build", "--platform", dockerPlatform, "-t", imageTag, "-f", "-", workDir], {
    input: dockerfile,
  });

  log("start container");
  await run("docker", [
    "run",
    "--platform",
    dockerPlatform,
    "-d",
    "--name",
    containerName,
    "-p",
    "127.0.0.1:0:22",
    imageTag,
  ]);
  cleanups.push(async () => {
    if (!keep)
      await run("docker", ["rm", "-f", containerName], { allowFailure: true, quiet: true });
  });
  await run(
    "docker",
    [
      "exec",
      "-i",
      containerName,
      "sh",
      "-c",
      "cat >> /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys",
    ],
    { input: publicKey },
  );
  const { stdout: portOutput } = await run("docker", ["port", containerName, "22/tcp"]);
  const sshPort = Number(portOutput.trim().split(":").pop());
  assert(Number.isInteger(sshPort) && sshPort > 0, `resolve ssh port from: ${portOutput}`);

  const sshBaseArgs = [
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "LogLevel=ERROR",
    "-i",
    keyPath,
    "-p",
    String(sshPort),
  ];
  const sshTargetHost = "root@127.0.0.1";
  const ssh = (remoteCommand) => run("ssh", [...sshBaseArgs, sshTargetHost, remoteCommand]);

  await retry("ssh connectivity", 30, 1000, () => ssh("true"));
  log(`sshd ready on 127.0.0.1:${sshPort}`);

  log("scp release archive and extract");
  await run("scp", [
    ...sshBaseArgs.map((arg) => (arg === "-p" ? "-P" : arg)),
    releaseArchive,
    `${sshTargetHost}:/root/`,
  ]);
  await ssh(
    `mkdir -p /root/lcode-server && tar -xzf /root/lcode-server-${target}.tar.gz -C /root/lcode-server --strip-components=1`,
  );

  log("start daemon on remote");
  const { stdout: daemonOutput } = await ssh("/root/lcode-server/bin/lcode serve --daemon --json");
  const daemonStatus = JSON.parse(daemonOutput.trim().split("\n").pop());
  assert(daemonStatus.state === "ready", `daemon ready, got: ${daemonOutput}`);
  assert(
    daemonStatus.host === "127.0.0.1",
    `daemon binds loopback only, got: ${daemonStatus.host}`,
  );
  const remotePort = daemonStatus.port;
  log(`remote core ready at 127.0.0.1:${remotePort} (pid ${daemonStatus.pid})`);

  // Core 只监听远端回环地址；ssh -L 隧道是到达它的唯一路径。
  const localPort = await findFreePort();
  log(`open tunnel 127.0.0.1:${localPort} -> remote 127.0.0.1:${remotePort}`);
  const tunnel = spawn(
    "ssh",
    [...sshBaseArgs, "-N", "-L", `${localPort}:127.0.0.1:${remotePort}`, sshTargetHost],
    { stdio: "ignore" },
  );
  cleanups.push(() => {
    if (!keep) tunnel.kill("SIGTERM");
  });
  const baseUrl = `http://127.0.0.1:${localPort}`;

  const serverInfo = await retry("server-info via tunnel", 20, 500, async () => {
    const response = await fetch(`${baseUrl}/api/server-info`);
    assert(response.ok, `server-info status ${response.status}`);
    return await response.json();
  });
  assert(
    serverInfo.capabilities?.websocketRpc === true,
    "server-info reports websocketRpc capability",
  );
  log(`server-info ok: serverId=${serverInfo.serverId} version=${serverInfo.version}`);

  log("verify web replayable /ws upgrade");
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);
    const timer = setTimeout(() => rejectPromise(new Error("/ws upgrade timed out")), 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });

  log("verify /ws/host capability gate");
  // capability middleware 在 WS 升级前检查请求头，普通 GET 即可验证 401 边界；
  // undici fetch 禁止手动设置 upgrade 头，也不需要。
  const unauthorized = await fetch(`${baseUrl}/ws/host`);
  assert(
    unauthorized.status === 401,
    `/ws/host without ticket must be 401, got ${unauthorized.status}`,
  );
  const ticketResponse = await fetch(`${baseUrl}/api/rpc-host-capability`, { method: "POST" });
  const ticket = await ticketResponse.json();
  assert(
    typeof ticket.capability === "string" && ticket.capability.length > 0,
    "capability ticket issued",
  );
  await new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws/host`, {
      headers: { [HOST_CAPABILITY_HEADER]: ticket.capability },
    });
    const timer = setTimeout(() => rejectPromise(new Error("/ws/host upgrade timed out")), 10_000);
    socket.once("open", () => {
      clearTimeout(timer);
      socket.close();
      resolvePromise();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  const replayed = await fetch(`${baseUrl}/ws/host`, {
    headers: { [HOST_CAPABILITY_HEADER]: ticket.capability },
  });
  assert(replayed.status === 401, `replayed ticket must be 401, got ${replayed.status}`);
  log("ws contracts ok (replayable upgrade, host gate, one-time ticket)");

  // linux 的 pty.node 走 @lydell 补齐路径（打包时特殊处理），必须在真实目标平台验证可加载。
  log("verify node-pty spawns a real pty on remote");
  await ssh(
    "cd /root/lcode-server/runtime && ./node -e \"const pty=require('node-pty');const p=pty.spawn('/bin/echo',['pty-ok'],{cols:80,rows:24});let o='';p.onData(d=>o+=d);p.onExit(()=>{process.exit(o.includes('pty-ok')?0:1)})\"",
  );
  log("node-pty ok");

  log("verify remote lifecycle status/stop");
  const { stdout: statusOutput } = await ssh("/root/lcode-server/bin/lcode status --json");
  assert(
    JSON.parse(statusOutput.trim().split("\n").pop()).state === "ready",
    "remote status ready",
  );
  await ssh("/root/lcode-server/bin/lcode stop --json");
  const { stdout: stoppedOutput } = await ssh("/root/lcode-server/bin/lcode status --json");
  const stopped = JSON.parse(stoppedOutput.trim().split("\n").pop());
  assert(stopped.state === "stopped", `remote stopped, got ${stopped.state}`);
  log("lifecycle ok (ready -> stop -> stopped)");

  if (keep) {
    log(
      `kept for debugging: container=${containerName} ssh="ssh ${sshBaseArgs.join(" ")} ${sshTargetHost}" tunnel=127.0.0.1:${localPort}`,
    );
  }
  log("ALL CHECKS PASSED");
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  exitCode = 1;
  console.error("[verify-remote-ssh] FAILED:", error instanceof Error ? error.message : error);
} finally {
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch {
      // 清理失败不掩盖主流程结果。
    }
  }
}
process.exit(exitCode);
