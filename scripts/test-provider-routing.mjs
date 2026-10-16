import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const groups = [
  [
    "packages/provider/test",
    /^(?:routing-.*|model-membership.*|model-interaction-protocol|provider-api-keys|provider-network|rate-limit)\.test\.ts$/u,
  ],
  [
    "packages/services/src/model-provider",
    /^(?:providerAccounts?.*|providerProxyPersistence|providerRuntimeLargeKeys|providerSettingsLargeKeys)\.test\.ts$/u,
  ],
  ["apps/lcode-cli/packages/adapters/src/model", /^api-key-.*\.test\.ts$/u],
  [
    "packages/provider-node/src/provider-auth/native",
    /^(?:routing-single-attempt|copilot-auto.*|copilot-manual|google-refresh)\.test\.ts$/u,
  ],
  ["apps/lcode-cli/packages/bootstrap/src/lcode-protocol", /^provider-runtime-headers\.test\.ts$/u],
];
const files = process.argv.includes("--ui")
  ? ["packages/web/test/provider-routing.test.mjs"]
  : (
      await Promise.all(
        groups.map(async ([directory, pattern]) =>
          (await readdir(new URL(`../${directory}/`, import.meta.url)))
            .filter((name) => pattern.test(name))
            .map((name) => `${directory}/${name}`),
        ),
      )
    )
      .flat()
      .sort();
const child = spawn(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=4", ...files],
  { cwd: root, windowsHide: true, stdio: "inherit" },
);
child.once("error", (error) => {
  throw error;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
