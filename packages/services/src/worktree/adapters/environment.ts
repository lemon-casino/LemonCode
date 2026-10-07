import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 即使声明被 Git ignore，变化也必须使候选证据失效；固定清单和字节预算避免无界扫描。 */
export async function worktreeDeclarationDigest(root: string): Promise<string> {
  const hash = createHash("sha256");
  let bytes = 0;
  for (const name of [
    "mise.toml", ".mise.toml", "mise.lock", ".tool-versions", ".node-version", ".nvmrc",
    ".python-version", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "package-lock.json",
    "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb", ".npmrc", ".yarnrc.yml",
    "go.mod", "go.sum", "go.work", "Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml",
    "pyproject.toml", "uv.lock", "poetry.lock", "requirements.txt", "Pipfile", "Pipfile.lock",
  ]) {
    hash.update(`${name}\0`);
    try {
      const stat = await lstat(join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe environment declaration: ${name}`);
      bytes += stat.size;
      if (stat.size > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024)
        throw new Error("Environment declarations exceed the bounded validation budget");
      hash.update(await readFile(join(root, name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function regularFile(root: string, name: string) {
  try {
    return (await lstat(join(root, name))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function packageManifest(
  root: string,
): Promise<{ packageManager?: unknown; scripts?: Record<string, unknown> } | null> {
  if (!(await regularFile(root, "package.json"))) return null;
  if ((await lstat(join(root, "package.json"))).size > 1024 * 1024) return null;
  try {
    const value: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    return value && typeof value === "object" ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** 只采用明确的锁文件；不执行清单中任意自定义字符串或猜测平台 Shell。 */
export async function detectWorktreeSetup(root: string): Promise<string[]> {
  if (await regularFile(root, "package.json")) {
    const manifest = await packageManifest(root);
    if (!manifest) return [];
    const declaration =
      typeof manifest.packageManager === "string"
        ? manifest.packageManager.match(/^(npm|pnpm|yarn|bun)@([0-9]+)[\w.+-]*$/)
        : null;
    if (manifest.packageManager !== undefined && !declaration) return [];
    const declared = declaration?.[1];
    const plans = [
      ["pnpm", "pnpm-lock.yaml", "pnpm install --frozen-lockfile"],
      ["npm", "package-lock.json", "npm ci"],
      [
        "yarn",
        "yarn.lock",
        declared === "yarn" && Number(declaration?.[2]) >= 2
          ? "yarn install --immutable"
          : "yarn install --frozen-lockfile",
      ],
      ["bun", "bun.lock", "bun install --frozen-lockfile"],
      ["bun", "bun.lockb", "bun install --frozen-lockfile"],
    ] as const;
    const matched = [];
    for (const [manager, file, command] of plans) {
      if ((!declared || declared === manager) && (await regularFile(root, file)))
        matched.push(command);
    }
    // 多个包管理器锁文件且没有明确声明时拒绝猜测；交给任务内 Agent 判定。
    return new Set(matched).size === 1 ? [matched[0]!] : [];
  }
  if (await regularFile(root, "go.mod")) return ["go mod download"];
  if ((await regularFile(root, "Cargo.lock")) && (await regularFile(root, "Cargo.toml")))
    return ["cargo fetch --locked"];
  if ((await regularFile(root, "uv.lock")) && (await regularFile(root, "pyproject.toml")))
    return ["uv sync --frozen"];
  return [];
}

export async function detectWorktreeValidation(root: string): Promise<string[]> {
  if (await regularFile(root, "package.json")) {
    const scripts = (await packageManifest(root))?.scripts;
    const setup = await detectWorktreeSetup(root);
    const manager = setup[0]?.split(" ")[0];
    if (!manager || !scripts || typeof scripts !== "object") return [];
    // test 常为 watch/dev 入口；仅采用约定的 CI 测试，不把缺少测试说成已验证。
    const names = ["typecheck", "lint", "test:ci"].filter(
      (name) => typeof scripts[name] === "string" && scripts[name],
    );
    return names.length ? [...setup, ...names.map((name) => `${manager} run ${name}`)] : [];
  }
  if (await regularFile(root, "go.mod")) return ["go mod download", "go test ./..."];
  if ((await regularFile(root, "Cargo.lock")) && (await regularFile(root, "Cargo.toml")))
    return ["cargo test --locked"];
  return [];
}
