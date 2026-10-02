import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import { resolveRunCommand, spawnCommand } from "./spawn-command.mjs";

const [requestedCommand, ...args] = process.argv.slice(2);
if (!requestedCommand) {
  console.error("Usage: node scripts/mise-run.mjs <command> [...args]");
  process.exit(1);
}

const env = withPinnedNodePath(process.env, process.execPath);

// Node shim 可能再次进入 CMD；沿用启动器的真实 runtime，避免内联代码被二次解析。
// Windows 上的 pnpm/npm 优先走磁盘真实 .cjs 入口，跳过 Volta 等 shim 的参数重解析。
const resolved = resolveRunCommand(requestedCommand, {
  env,
  nodeExecutablePath: process.execPath,
});
const child = spawnCommand(resolved.command, [...resolved.args, ...args], {
  cwd: process.cwd(),
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(`[mise-run] failed to start ${requestedCommand}: ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
