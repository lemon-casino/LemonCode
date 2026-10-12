import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import {
  assertRuntimeDevelopmentDataRoot,
  withDefaultDevelopmentDataRoot,
} from "./runtime-development-env.mjs";
import { resolveRunCommand, spawnCommand } from "./spawn-command.mjs";

const requestedEnv = process.argv[2]?.trim().toLowerCase();
const agentBytecode = process.argv.slice(3).includes("--agent-bytecode");
const prepareOnly = process.argv.slice(3).includes("--prepare-only");
const runtimeOnly = process.argv.slice(3).includes("--runtime-only");
if (prepareOnly && runtimeOnly) throw new Error("Choose only one desktop development phase");
if (requestedEnv !== "test" && requestedEnv !== "production") {
  console.error("Usage: node scripts/dev-desktop-env.mjs <test|production> [--agent-bytecode]");
  process.exit(1);
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDevelopmentDataRoot = resolve(
  process.env.HOME || process.env.USERPROFILE || repoRoot,
  ".lcode-dev-home",
);
assertRuntimeDevelopmentDataRoot(process.env);
const runtimeEnv =
  requestedEnv === "test"
    ? withDefaultDevelopmentDataRoot(process.env, defaultDevelopmentDataRoot)
    : process.env;
// 修复：托管环境提供冻结 npm_execpath，不能改成 pnpm.cmd 后误用全局工具和 Node。
const managed = Boolean(runtimeEnv.LCODE_RUNTIME_ENVIRONMENT_ID);
const pnpm = managed
  ? resolveRunCommand("pnpm", {
      env: runtimeEnv,
      nodeExecutablePath: process.execPath,
      preferNativePath: true,
    })
  : { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: [] };
const runPnpm = (args) => run(pnpm.command, [...pnpm.args, ...args]);

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const launchEnv = {
      ...runtimeEnv,
      LCODE_ENV: requestedEnv,
      LCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
    };
    const child = spawnCommand(command, args, {
      cwd: repoRoot,
      // 本机模式沿用户系统环境；只有托管模式固定后续子进程的 Node。
      env: managed ? withPinnedNodePath(launchEnv, process.execPath) : launchEnv,
      stdio: "inherit",
    });

    child.on("error", rejectRun);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolveRun();
        return;
      }
      rejectRun(
        new Error(
          signal
            ? `${command} exited with signal ${signal}`
            : `${command} exited with code ${code ?? "unknown"}`,
        ),
      );
    });
  });
}

try {
  // The public dev scripts delegate here instead of invoking the package's
  // `dev` lifecycle directly, so pnpm will not run `pre-dev` automatically.
  // Preserve its runtime-asset preparation and stale `out` cleanup explicitly
  // before rebuilding bundles or starting Electron.
  if (!runtimeOnly) {
    await runPnpm(["--filter", "@lcode/desktop", "pre-dev"]);
    await run(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")]);
    if (agentBytecode) {
      await run(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs")]);
    }
  }
  if (!prepareOnly) await runPnpm(["--filter", "@lcode/desktop", "dev:runtime"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
