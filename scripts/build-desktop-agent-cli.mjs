import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageAgentBundle } from "../packages/desktop/scripts/stage-agent-bundle.mjs";
import { runCommand } from "./spawn-command.mjs";
import { resolveBuiltinProviderBuildEnvironment } from "./builtin-provider-config.mjs";
import { generateThirdPartyNotices } from "./generate-third-party-notices.mjs";
import { readReleaseVerifiedNotices } from "./third-party-notices.mjs";

const defaultRepoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function prepareDesktopAgentInputs({
  repoRoot = defaultRepoRoot,
  env = process.env,
  run = runCommand,
  generate = generateThirdPartyNotices,
  verify = readReleaseVerifiedNotices,
} = {}) {
  // 修复：worker-source.ts 是编译输入，手动生成会使本地和 tag 打包静默携带过期 OAuth 适配。
  await run(process.execPath, [resolve(repoRoot, "scripts/build-auth-plugin-worker.mjs")], {
    cwd: repoRoot,
    env,
  });
  if (env.LCODE_VERIFY_RELEASE_INPUTS === "1") await verify(repoRoot);
  else await generate(repoRoot);
}
// 桌面 Agent 构建有普通 pnpm 和 bootstrap:with-remote 直跑 tsc 两条路径。
// 过去两条路径分别维护依赖顺序，新增 workspace 依赖时只更新了 bootstrap 依赖，
// 干净 CI 中该依赖的 dist 尚不存在，bootstrap 会因无法解析类型入口而失败。
// 两条路径统一从这一份有序清单派生，避免后续新增 workspace 依赖时再次漂移。
const cliWorkspaceBuilds = [
  { packageName: "@lcode/shared-types", packageDir: "shared-types" },
  { packageName: "@lcode/contracts", packageDir: "contracts" },
  // dynamic-workflow 的 tsc 构建依赖 gitignored 的 libs.generated.ts，
  // 而 bare-tsc 路径（runBootstrapWithRemoteBuild）不会执行 package build script，
  // 所以需要先跑生成脚本；必须排在 @lcode/core 之前，core 依赖 dynamic-workflow。
  {
    packageName: "@lcode/dynamic-workflow",
    packageDir: "dynamic-workflow",
    prepareScript: "scripts/generate-libs.mjs",
  },
  // dynamic-workflow-runtime 的类型入口是 dist/index.d.ts，必须先于 bootstrap 构建。
  { packageName: "@lcode/dynamic-workflow-runtime", packageDir: "dynamic-workflow-runtime" },
  { packageName: "@lcode/core", packageDir: "core" },
  { packageName: "@lcode/adapters", packageDir: "adapters" },
  { packageName: "@lcode/i18n", packageDir: "i18n" },
  { packageName: "@lcode/telemetry", packageDir: "telemetry" },
  { packageName: "@lcode/bootstrap", packageDir: "bootstrap" },
];
// 官方插件 manifest 可以在 server.js 缺失时被 filesystem seed，直到 session
// 连接 MCP 才报错，造成“Helper ready 但 CUA 工具不存在”的半启动状态。所有普通 Dev 必需的
// 独立 MCP runtime 必须集中登记，并在构建后验证真实入口文件，再允许 Agent bundle 启动。
const requiredDevPluginRuntimeBuilds = [
  {
    // node_repl 宿主：Browser Use 与 Computer Use 共用，产物归属独立包。
    packageName: "@lcode/node-repl-host",
    packageDir: "node-repl-host",
    artifactPath: "node-repl-host/dist/mcp/server.js",
  },
  {
    // browser-use 自己的 runtime 只剩 browser-client；宿主不再由它携带。
    packageName: "@lcode/browser-use-plugin",
    packageDir: "browser-use-plugin",
    artifactPath: "browser-use-plugin/scripts/browser-client.mjs",
  },
];
const defaultBuildFilters = cliWorkspaceBuilds.map(({ packageName }) => packageName);

async function buildRequiredPluginRuntimes(repoRoot, env, run) {
  for (const { packageName, packageDir } of requiredDevPluginRuntimeBuilds) {
    const cwd = resolve(repoRoot, "apps/lcode-cli/packages", packageDir);
    if (env.LCODE_BOOTSTRAP_WITH_REMOTE === "1") {
      await run(process.execPath, ["../../node_modules/typescript/bin/tsc"], { cwd, env });
      await run(process.execPath, [resolve(cwd, "scripts/build.mjs")], { cwd, env });
    } else {
      await run("pnpm", ["--filter", packageName, "build"], { cwd: repoRoot, env });
    }
  }
}

async function verifyRequiredDevPluginRuntimeArtifacts(repoRoot, checkArtifact) {
  for (const runtime of requiredDevPluginRuntimeBuilds) {
    const artifactPath = resolve(repoRoot, "apps/lcode-cli/packages", runtime.artifactPath);
    try {
      await checkArtifact(artifactPath);
    } catch (error) {
      throw new Error(
        `[build-desktop-agent-cli] ${runtime.packageName} build succeeded without required MCP runtime: ${artifactPath}`,
        { cause: error },
      );
    }
  }
}

async function runBootstrapWithRemoteBuild(repoRoot, pnpmRunEnv, run) {
  // 修复：文件存在只说明曾构建，不能证明属于当前源码；bootstrap 必须和本地/tag 一样重建。
  for (const { packageDir, prepareScript } of cliWorkspaceBuilds) {
    // bootstrap:with-remote 会在 remote assets 阶段构建 agent bundle。
    // 通过 pnpm 逐包执行 tsc 时会再走 shim/env node 层，低内存本地环境里容易长时间卡住。
    // 这里只有 bootstrap 专用环境变量生效，直接复用当前 Node 启动 TypeScript CLI。
    // bare tsc 绕过 package build script，所以带 prepareScript 的包（dynamic-workflow）
    // 必须先手动跑生成脚本补齐 gitignored 的 libs.generated.ts，否则 tsc 因缺文件报错。
    if (prepareScript) {
      await run(process.execPath, [prepareScript], {
        cwd: resolve(repoRoot, "apps/lcode-cli/packages", packageDir),
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }
    await run(process.execPath, ["../../node_modules/typescript/bin/tsc"], {
      cwd: resolve(repoRoot, "apps/lcode-cli/packages", packageDir),
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  }

  await run(process.execPath, ["scripts/build.mjs", "--desktop-agent"], {
    cwd: resolve(repoRoot, "apps/lcode-cli/packages/cli"),
    env: pnpmRunEnv,
    stdio: "inherit",
  });
}

// dev 的 Agent 查找只消费 bundled-agents，编译后必须同步；生产入口则由目标 staging owner 统一同步。
export async function buildDesktopAgent({
  repoRoot = defaultRepoRoot,
  env = process.env,
  run = runCommand,
  prepare = prepareDesktopAgentInputs,
  stage = stageAgentBundle,
  checkArtifact = access,
  stageBundle = true,
} = {}) {
  const pnpmRunEnv = {
    ...env,
    // adapters tsc 在内存受限机器上会 OOM；只改变构建子进程，不污染导入该脚本的测试进程。
    NODE_OPTIONS: `${env.NODE_OPTIONS ?? ""} --max-old-space-size=8192`.trim(),
    LCODE_ENV: await resolveBuiltinProviderBuildEnvironment({ root: repoRoot, env }),
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
  };
  await prepare({ repoRoot, env: pnpmRunEnv, run });
  if (env.LCODE_BOOTSTRAP_WITH_REMOTE === "1") {
    await runBootstrapWithRemoteBuild(repoRoot, pnpmRunEnv, run);
  } else if (env.LCODE_DESKTOP_AGENT_BUILD_MODE !== "turbo") {
    // Linux 容器 demo 里没有仓库级 turbo 根，`turbo --cwd apps/lcode-cli`
    // 会把 apps/lcode-cli 当根目录，并拒绝 turbo.json 中指向 ../../packages/shared 的 inputs。
    // 同时 agent 子 workspace 不包含根 packages/shared，但 agent 包依赖 @lcode/shared。
    // 因此默认改用仓库根 workspace 的明确 pnpm 包顺序构建，避免 WDIO 前置构建卡在子 workspace 解析。
    for (const filter of defaultBuildFilters) {
      await run("pnpm", ["--filter", filter, "build"], {
        cwd: repoRoot,
        env: pnpmRunEnv,
        stdio: "inherit",
      });
    }

    await run("pnpm", ["--filter", "@lcode/cli", "build:desktop-agent"], {
      cwd: repoRoot,
      env: pnpmRunEnv,
      stdio: "inherit",
    });
  } else {
    await run(
      "pnpm",
      [
        "exec",
        "turbo",
        "--skip-infer",
        "--cwd",
        "apps/lcode-cli",
        "run",
        "build:desktop-agent",
        "--filter=@lcode/cli",
      ],
      {
        cwd: repoRoot,
        env: pnpmRunEnv,
        stdio: "inherit",
      },
    );
  }
  // 修复：Turbo/bootstrap 不能绕过插件 runtime；所有分支在同一 owner 编译、验证，再交给 staging。
  await buildRequiredPluginRuntimes(repoRoot, pnpmRunEnv, run);
  await verifyRequiredDevPluginRuntimeArtifacts(repoRoot, checkArtifact);
  await checkArtifact(resolve(repoRoot, "apps/lcode-cli/packages/cli/dist/lcode.cjs"));
  if (stageBundle) await stage({ repoRoot, platformKey: `${process.platform}-${process.arch}` });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktopAgent({ stageBundle: !process.argv.includes("--no-stage") });
}
