import { join, relative, sep } from "node:path";
import { frozenManifestSchema } from "@lcode/shared";
import { valid } from "semver";
import { backendPlatformKey, detectBackendPlatform } from "./backendPlatform.js";
import { managerCommand } from "./dependencyInstall.js";
import { inspectResourcePath, ResourceBudget } from "./resourceFilesystem.js";
import { readResourceJson, resourceNames } from "./resourceReferences.js";

/** 只采用该数据根已冻结且仍在 tool-store 的工具，不查 PATH，不安装或恢复环境。 */
export async function resolvePackageCacheTools(root: string) {
  const budget = new ResourceBudget({ maxEntries: 20_000, maxDurationMs: 2_000 });
  const directory = join(root, "manifests");
  const platform = backendPlatformKey(detectBackendPlatform());
  for (const name of await resourceNames(root, directory, budget)) {
    if (!/^[a-f0-9]{32}\.json$/u.test(name)) throw new Error("package tools unavailable");
    const manifest = frozenManifestSchema.parse(
      await readResourceJson(root, join(directory, name), budget),
    );
    const node = manifest.tools.find((tool) => tool.key === "node")?.toolPath;
    const pnpm = manifest.tools.find((tool) => tool.key === "pnpm")?.toolPath;
    if (!node || !pnpm) continue;
    const locks: string[] = [];
    let available = true;
    for (const [key, path] of [
      ["node", node],
      ["pnpm", pnpm],
    ] as const) {
      const parts = relative(root, path).split(sep);
      if (
        parts[0] !== "tool-store" ||
        parts[1] !== "mise" ||
        parts[3] !== platform ||
        parts[4] !== "data" ||
        parts[5] !== "installs" ||
        parts[6] !== key ||
        !parts[7] ||
        valid(parts[7]) !== parts[7] ||
        parts[7] !== manifest.tools.find((tool) => tool.key === key)?.version ||
        parts[2] !== manifest.backendVersion
      ) {
        available = false;
        break;
      }
      if (!(await inspectResourcePath(root, path, true))?.isFile()) {
        available = false;
        break;
      }
      locks.push(join(root, ...parts.slice(0, 4), `${platform}-${key}-${parts[7]}.lock`));
    }
    if (available)
      return { node, pnpm, locks, command: await managerCommand("pnpm", { node, pnpm }) };
  }
  throw new Error("package tools unavailable");
}
