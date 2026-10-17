import { spawn } from "node:child_process";
import { resolve } from "node:path";

const backend = [
  "packages/services/src/project-execution-set/executionSet.integration.test.ts",
  "packages/services/src/project-execution-set/executionSetRecovery.integration.test.ts",
  "packages/services/src/project-execution-set/executionSetPublication.integration.test.ts",
  "packages/services/src/setting/projectMutations.test.ts",
  "packages/services/src/setting/projectCustomRole.test.ts",
  "packages/services/src/setting/projectSettingsRead.test.ts",
  "packages/services/src/sidebar-organization/organization.test.ts",
  "packages/services/src/lcode-agent/projectContextScope.test.ts",
  "packages/services/src/worktree/worktreeOwnedBinding.integration.test.ts",
  "packages/shared/src/projectContext.test.ts",
  "packages/ui/src/lib/sidebarOrganization.test.ts",
  "packages/ui/src/WorkspaceSidebar/sidebarFocusProjection.test.ts",
  "scripts/sidebar-project-context-admission.test.ts",
  "scripts/sidebar-execution-set-protocol.test.ts",
  "apps/lcode-cli/packages/core/src/runtime/methods/project-filesystem-mcp.test.ts",
  "apps/lcode-cli/packages/core/src/runtime/methods/turn-project-context.test.ts",
  "apps/lcode-cli/packages/bootstrap/src/lcode-protocol/worktree-execution.test.ts",
  "apps/lcode-cli/packages/bootstrap/src/lcode-protocol/sidebar-fork.test.ts",
  "apps/lcode-cli/packages/bootstrap/src/lcode-protocol/resource-release-close.test.ts",
];
const browser = [
  "sidebar-organization",
  "sidebar-organization-transactions",
  "sidebar-source-errors",
  "sidebar-organize-position",
  "sidebar-focus",
  "worktree-sidebar-menus",
  "sidebar-project-editing",
  "project-form-details",
  "project-editor-close",
  "project-folders",
  "sidebar-collaboration-completion",
  "sidebar-execution-sets",
].map((name) => `packages/web/test/${name}.test.mjs`);
async function run(args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: resolve("."),
    windowsHide: true,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code) process.exit(code);
}
await run(["--import", "tsx", "--test", ...backend], {
  TSX_TSCONFIG_PATH: resolve("packages/ui/tsconfig.json"),
});
if (process.argv.includes("--ui")) await run(["--test", "--test-concurrency=1", ...browser]);
