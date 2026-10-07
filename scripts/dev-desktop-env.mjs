import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import {
  assertRuntimeDevelopmentDataRoot,
  withDefaultDevelopmentDataRoot,
} from "./runtime-development-env.mjs";
import { spawnCommand } from "./spawn-command.mjs";

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
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const defaultDevelopmentDataRoot = resolve(
  process.env.HOME || process.env.USERPROFILE || repoRoot,
  ".lcode-dev-home",
);
assertRuntimeDevelopmentDataRoot(process.env);
const runtimeEnv =
  requestedEnv === "test"
    ? withDefaultDevelopmentDataRoot(process.env, defaultDevelopmentDataRoot)
    : process.env;

function run(command, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawnCommand(command, args, {
      cwd: repoRoot,
      env: withPinnedNodePath(
        {
          ...runtimeEnv,
          LCODE_ENV: requestedEnv,
          LCODE_DESKTOP_AGENT_BYTECODE: agentBytecode ? "1" : "0",
        },
        process.execPath,
      ),
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
    await run(pnpmCommand, ["--filter", "@lcode/desktop", "pre-dev"]);
    await run(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-cli.mjs")]);
    if (agentBytecode) {
      await run(process.execPath, [resolve(repoRoot, "scripts/build-desktop-agent-bytecode.mjs")]);
    }
  }
  if (!prepareOnly) await run(pnpmCommand, ["--filter", "@lcode/desktop", "dev:runtime"]);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
