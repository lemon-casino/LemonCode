import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import YAML from "yaml";
import { execCommand } from "./spawn-command.mjs";

export const hashBytes = (bytes) => createHash("sha256").update(bytes).digest("hex");
const noticeName =
  /(?:^|[._-])(?:licen[sc]es?|copying|notice|copyright|unlicense|third.party|ofl)(?:[._-]|$)/iu;

export async function readPackageNotices(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (["node_modules", ".git", "test", "tests", "fixtures"].includes(entry.name)) continue;
      // Chromium 聚合许可由打包流程经 resources/licenses/electron 单独分发，不进 npm 通知。
      if (entry.isFile() && entry.name === "LICENSES.chromium.html") continue;
      const full = join(path, entry.name);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile() && noticeName.test(entry.name)) {
        const bytes = await readFile(full);
        if (bytes.includes(0) || bytes.length === 0) continue;
        files.push({ member: relative(directory, full).replaceAll("\\", "/"), bytes });
      } else if (entry.isFile() && /^readme(?:\.[^/]*)?$/iu.test(entry.name)) {
        const text = await readFile(full, "utf8");
        const match = /^(?:#{1,6}\s+licen[sc]e[^\n]*\n|licen[sc]e\s*\n[=-]+\n)/imu.exec(text);
        if (match) {
          const section = text.slice(match.index).split(/\n(?=#{1,6}\s)/u)[0];
          files.push({
            member: `${relative(directory, full).replaceAll("\\", "/")} (license section)`,
            bytes: Buffer.from(section),
          });
        }
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.member.localeCompare(b.member, "en"));
}

function currentArchitectures() {
  return {
    os: process.platform,
    cpu: process.arch,
    libc:
      process.platform === "linux"
        ? process.report.getReport().header.glibcVersionRuntime
          ? "glibc"
          : "musl"
        : undefined,
  };
}

function platformMatches(conditions, targets) {
  // 未知平台不能证明包不适用；无条件、any 和纯否定列表遵循包管理器的平台语义。
  if (typeof conditions === "string") conditions = [conditions];
  if (!Array.isArray(conditions) || !conditions.length || targets.includes(undefined)) return true;
  conditions = conditions.filter((value) => typeof value === "string");
  if (conditions.length === 1 && conditions[0] === "any") return true;
  // pnpm 10 的否定条件针对全部支持目标；任一目标命中否定条件就不能安装。
  if (targets.some((target) => conditions.includes(`!${target}`))) return false;
  const negativeCount = conditions.filter((value) => value.startsWith("!")).length;
  return (
    targets.some((target) => conditions.includes(target)) ||
    negativeCount * targets.length === conditions.length
  );
}

function optionalSnapshotEdges(snapshots) {
  const edges = new Map();
  for (const [snapshotKey, snapshot] of Object.entries(snapshots ?? {})) {
    const key = snapshotKey.split("(")[0];
    const aliases = new Set(Object.keys(snapshot.optionalDependencies ?? {}));
    const previous = edges.get(key);
    // peer 实例的展示路径可能被 pnpm 哈希化；只合并所有实例一致声明的可选别名。
    edges.set(key, previous ? previous.intersection(aliases) : aliases);
  }
  return edges;
}

function productionPackages(projects, policy) {
  const own = new Set(projects.map((project) => project.name));
  const required = new Map();
  const current = policy.current ?? currentArchitectures();
  const optionalEdges = optionalSnapshotEdges(policy.snapshots);
  const targets = Object.fromEntries(
    ["os", "cpu", "libc"].map((dimension) => [
      dimension,
      (policy.supportedArchitectures?.[dimension] ?? ["current"]).map((value) =>
        value === "current" ? current[dimension] : value,
      ),
    ]),
  );
  function dependencies(deps, optional = false, ancestorExcluded = false, optionalAliases) {
    for (const [alias, info] of Object.entries(deps ?? {})) {
      const name = info.name ?? alias;
      const key = `${name}@${info.version}`;
      const metadata = policy.packages?.[key];
      // 修复：真实 pnpm ls 将嵌套 optionalDependencies 折叠进 dependencies，边类型须读锁文件。
      const optionalPath = optional || optionalAliases?.has(alias);
      const platformExcluded =
        ancestorExcluded ||
        (optionalPath &&
          Object.entries(targets).some(
            ([dimension, values]) =>
              !(dimension === "libc" && !current.libc) &&
              !platformMatches(metadata?.[dimension], values),
          ));
      if (!own.has(name) && !name.startsWith("@lcode/") && !info.version.startsWith("link:")) {
        // 修复：pnpm ls 可保留未实装的平台可选边，不能强制 glibc 构建安装 musl 包。
        // 同版本只要存在一条受支持/必需路径就必须安装，不能由另一路可选边降级检查。
        const previous = required.get(key);
        required.set(key, {
          name,
          version: info.version,
          ...(platformExcluded && (!previous || previous.platformExcluded)
            ? { platformExcluded: true }
            : {}),
        });
      }
      dependencies(info.dependencies, optionalPath, platformExcluded, optionalEdges.get(key));
      dependencies(info.optionalDependencies, true, platformExcluded);
    }
  }
  for (const project of projects) {
    const importer =
      policy.workspaceRoot && project.path
        ? policy.importers?.[
            relative(policy.workspaceRoot, project.path).replaceAll("\\", "/") || "."
          ]
        : undefined;
    dependencies(
      project.dependencies,
      false,
      false,
      new Set(Object.keys(importer?.optionalDependencies ?? {})),
    );
    dependencies(project.optionalDependencies, true);
  }
  return required;
}

export function assertProductionGraphs(lockedProjects, installedProjects, policy = {}) {
  const locked = productionPackages(lockedProjects, policy);
  const installed = productionPackages(installedProjects, policy);
  const missing = [...locked].filter(
    ([key, item]) => !installed.has(key) && !item.platformExcluded,
  );
  const stale = [...installed.keys()].filter((key) => !locked.has(key));
  if (missing.length || stale.length) {
    throw new Error(
      `Installed production graph differs from pnpm-lock.yaml. Run pnpm install --frozen-lockfile.\nMissing: ${missing.map(([key]) => key).join(", ")}\nStale: ${stale.join(", ")}`,
    );
  }
  return locked;
}

export async function readWorkspaceProductionGraph(root) {
  root = await realpath(root);
  // 修复：pnpm ls 默认读取安装快照，不能把旧图与当前锁文件哈希拼成有效声明。
  const [locked, actual, workspace, lockfile] = await Promise.all([
    readPnpmProductionProjects(root, true),
    readPnpmProductionProjects(root, false),
    readFile(join(root, "pnpm-workspace.yaml"), "utf8").then(YAML.parse),
    readFile(join(root, "pnpm-lock.yaml"), "utf8").then(YAML.parse),
  ]);
  const required = assertProductionGraphs(locked, actual, {
    packages: lockfile.packages,
    snapshots: lockfile.snapshots,
    importers: lockfile.importers,
    workspaceRoot: root,
    supportedArchitectures: workspace.supportedArchitectures,
  });
  return { required, projects: actual };
}

async function readPnpmProductionProjects(root, lockfileOnly) {
  const options = {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  };
  const suffix = lockfileOnly ? ["--lockfile-only"] : [];
  try {
    const { stdout } = await execCommand(
      "pnpm",
      ["-r", "ls", "--prod", "--json", "--depth", "Infinity", ...suffix],
      options,
    );
    return JSON.parse(stdout);
  } catch (error) {
    if (!String(error?.stdout ?? error).includes("EMFILE")) throw error;
  }

  // Bug 修复：Windows 的整仓 pnpm ls 可因打开过多 package.json 报 EMFILE；单包同深度
  // 查询正常。只在该错误下顺序拆包，仍用 pnpm 的真实 prod/lockfile 图做相同的交叉校验。
  const { stdout } = await execCommand("pnpm", ["-r", "ls", "--json", "--depth", "-1"], options);
  const workspaceProjects = JSON.parse(stdout);
  const projects = [];
  for (const project of workspaceProjects) {
    const filtered = await execCommand(
      "pnpm",
      ["--filter", project.name, "ls", "--prod", "--json", "--depth", "Infinity", ...suffix],
      options,
    );
    projects.push(...JSON.parse(filtered.stdout).filter((item) => item.name === project.name));
  }
  return projects;
}

export async function scanInstalledPackages(root, projects) {
  // pnpm hoisted 布局的 ls.path 仍可能指向不存在的 .pnpm 路径；按真实安装目录和精确版本匹配。
  const installed = new Map();
  const visited = new Set();
  async function scanNodeModules(directory) {
    let actual;
    try {
      actual = await realpath(directory);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (visited.has(actual)) return;
    visited.add(actual);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path)) await scanPackage(join(path, scoped));
      } else await scanPackage(path);
    }
  }
  async function scanPackage(directory) {
    let pkg;
    try {
      pkg = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes(error.code)) return;
      throw error;
    }
    if (pkg.name && pkg.version) installed.set(`${pkg.name}@${pkg.version}`, { pkg, directory });
    await scanNodeModules(join(directory, "node_modules"));
  }
  for (const project of projects) await scanNodeModules(join(project.path, "node_modules"));
  await scanNodeModules(join(root, "node_modules"));
  await scanNodeModules(join(root, "apps/lcode-cli/node_modules"));
  return installed;
}

export function missingProductionPackages(required, installed) {
  const missing = [...required].filter(([key]) => !installed.has(key)).map(([, item]) => item);
  for (const item of missing) {
    if (!item.platformExcluded)
      throw new Error(`Missing installed dependency: ${item.name}@${item.version}`);
  }
  return missing.map(({ name, version }) => ({ name, version }));
}

export async function collectNpmNotices(root, overrides) {
  root = await realpath(root);
  const { required, projects } = await readWorkspaceProductionGraph(root);
  // 修复：标识门禁和声明生成必须扫描同一安装集合，避免嵌套版本只进声明、不进门禁。
  const installed = await scanInstalledPackages(root, projects);
  const packages = [];
  const missing = [];
  const notInstalled = missingProductionPackages(required, installed);
  for (const [key, item] of [...required].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const installedPackage = installed.get(key);
    if (!installedPackage) {
      continue;
    }
    const { pkg, directory } = installedPackage;
    const notices = await readPackageNotices(directory);
    const override = overrides.find((record) => record.package === key);
    if (override?.file) {
      const bytes = await readFile(join(root, override.file));
      if (hashBytes(bytes) !== override.sha256) throw new Error(`Changed upstream notice: ${key}`);
      notices.push({ member: override.source, bytes });
    }
    // README 中仅有 MIT 等标签不能冒充完整许可文件；这种包仍需要版本固定的补充材料。
    if (
      !notices.some(({ member }) => !member.endsWith(" (license section)")) &&
      !override?.acceptedMissingNotice
    )
      missing.push(key);
    packages.push({
      name: item.name,
      version: item.version,
      license:
        pkg.license ??
        pkg.licenses?.map((item) => (typeof item === "string" ? item : item.type)).join(" OR ") ??
        override?.license ??
        "(not declared)",
      repository: typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url,
      ...(override?.acceptedMissingNotice
        ? { acceptedMissingNotice: override.acceptedMissingNotice }
        : {}),
      notices,
    });
  }
  if (missing.length) throw new Error(`Missing complete upstream notices:\n${missing.join("\n")}`);
  return {
    packages,
    notInstalled,
    workspaceManifests: projects.map((project) =>
      relative(root, join(project.path, "package.json")).replaceAll("\\", "/"),
    ),
  };
}
