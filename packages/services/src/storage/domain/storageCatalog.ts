/**
 * 存储分类目录：把 .lcode 根下的相对路径映射到类别、聚合 key 与可清理性。
 * 纯函数、单一事实源。
 * 匹配顺序：根级特例 → 文件规则（精确）→ 前缀规则（最长前缀优先）→ 其他。
 */
import type { StorageCategoryId, StorageCleanability, StorageRootId } from "@lcode/shared";

export interface StorageCatalogContext {
  rootId: StorageRootId;
  hasCustomDataBaseDir: boolean;
}

interface StorageClassification {
  categoryId: StorageCategoryId;
  /** 下钻明细的聚合 key：规则命中路径的下一级。 */
  entryKey: string;
}

/** 清理时需要枚举的范围；recursive=false 表示只看该目录直接子项（用于文件规则）。 */
export interface StorageCleanScope {
  prefix: string;
  recursive: boolean;
}

const CLEANABILITY: Record<StorageCategoryId, StorageCleanability> = {
  sessionStore: "none",
  // 只有 subagent 的 transcript.jsonl 可删，其余子代理文件继续保留。
  subagentTranscripts: "safe",
  toolOutputs: "none",
  mediaCache: "safe",
  editorCache: "safe",
  pnpmCache: "safe",
  temporaryFiles: "none",
  modelTrajectory: "safe",
  devTraces: "safe",
  logs: "safe",
  backups: "confirm",
  exports: "safe",
  runtimes: "none",
  worktreeData: "none",
  gitBackups: "none",
  config: "none",
  legacyData: "none",
  other: "none",
};

interface FileRule {
  categoryId: StorageCategoryId;
  pattern: RegExp;
  /** 聚合 key 取路径前 N 段（缺省用完整路径）。 */
  entryKeySegments?: number;
}

/** 文件级规则：按顺序求值，先命中先生效（备份/缓存要排在泛化的 config 之前）。 */
const FILE_RULES: FileRule[] = [
  // subagent 运行记录（单文件可达数十 MB），按会话目录聚合
  {
    categoryId: "subagentTranscripts",
    pattern: /^cli\/agents\/[^/]+\/[^/]+\/transcript\.jsonl$/,
    entryKeySegments: 3,
  },
  { categoryId: "sessionStore", pattern: /^v2\/[^/]+\.sqlite(?:-wal|-shm)?$/ },
  { categoryId: "sessionStore", pattern: /^cli\/db\/db\.sqlite(?:-wal|-shm)?$/ },
  { categoryId: "toolOutputs", pattern: /^v2\/checkpoints\/(?:.+\/)?(?:pending|tmp)\// },
  { categoryId: "backups", pattern: /^cli\/db\/db\.sqlite\.[^/]+$/ },
  { categoryId: "backups", pattern: /^cli\/config\.json\.bak[^/]*$/ },
  { categoryId: "backups", pattern: /^v2\/[^/]+\.bak$/ },
  { categoryId: "backups", pattern: /^v2\/[^/]+\.backup\.json$/ },
  { categoryId: "backups", pattern: /^v2\/setting\.json\.(?:corrupt-|[^/]*backup)[^/]*$/ },
  { categoryId: "backups", pattern: /^v2\/config\.json\.pre-[^/]+$/ },
  { categoryId: "toolOutputs", pattern: /^v2\/coding-plan-cache\.json$/ },
  // Bot 历史缓存仅供资源管理器识别展示，不加载配置或启动渠道。
  { categoryId: "toolOutputs", pattern: /^v2\/bots-model-cache[^/]*\.json$/ },
  { categoryId: "logs", pattern: /^computer-use\/run\/[^/]+\.log$/ },
  { categoryId: "config", pattern: /^v2\/[^/]+\.json$/ },
  { categoryId: "config", pattern: /^cli\/config\.json$/ },
  { categoryId: "config", pattern: /^agents\/[^/]+\.md$/ },
  { categoryId: "config", pattern: /^AGENTS\.md$/ },
];

/** 前缀规则：值为相对根的目录前缀，命中最长者。 */
const PREFIX_RULES: Record<Exclude<StorageCategoryId, "other">, string[]> = {
  sessionStore: ["v2/sessions", "v2/session-bindings", "v2/checkpoints"],
  // transcript.jsonl 由上面的文件规则先命中，其余 cli/agents 内容留在这里
  subagentTranscripts: [],
  toolOutputs: ["cli/artifacts", "cli/agents", "cli/sessions", "cli/exec"],
  mediaCache: ["cli/image-cache", "cli/pdf-cache", "cli/video-cache"],
  editorCache: ["editor-icon"],
  pnpmCache: ["v2/runtime-environments/package-store/pnpm"],
  // 临时附件可能仍被草稿、会话引用，不能仅因目录名为 tmp/cache 就删除。
  temporaryFiles: ["tmp", "cache", "clipboard"],
  modelTrajectory: ["cli/debug", "cli/rollout"],
  devTraces: ["v2/dev", "v2/acp-traffic-proxy", "v2/acp-stream-diagnostics"],
  logs: ["v2/logs", "cli/log", "logs", "v2/crash", "v2/perf", "feedback/logs"],
  backups: ["backup", "v2/backup", "v2/migrations", "cli/db/backup", "cli/db/backups"],
  exports: ["export-log", "export-log-stage", "feedback"],
  runtimes: [
    "agents",
    "bundled-agents",
    "lite",
    "computer-use",
    "cli/plugins",
    "v2/runtime-environments",
  ],
  worktreeData: ["v2/worktrees", "v2/git-review-workspaces", "git-checkpoint-index"],
  gitBackups: ["v2/git-backup"],
  legacyData: ["agent"],
  // cli/plugins 整体（含 cache）不可清理，插件缓存归运行时。
  config: [
    "v2/agent-config",
    "v2/bots-runtime-locks",
    "v2/bot-attachments",
    "v2/certs",
    "v2/acp-auth",
    "v2/acp-config",
    "v2/provider",
    "v2/runtime",
    "cli/models",
    "cli/memories",
    "cli/workflows",
    "security",
    "commands",
    "skills",
    "workflows",
    "workspace",
    "mailbox",
    "server",
    "controller",
    "launcher",
    "dev-signing",
    "cua-helper-dev-identity",
    "perf-task-manifests",
    "plugin-workspace",
    "projects",
  ],
};

const PREFIX_INDEX: Array<{ prefix: string; categoryId: StorageCategoryId }> = Object.entries(
  PREFIX_RULES,
)
  .flatMap(([categoryId, prefixes]) =>
    prefixes.map((prefix) => ({ prefix, categoryId: categoryId as StorageCategoryId })),
  )
  .sort((a, b) => b.prefix.length - a.prefix.length);

/** 任何类别下都不能删除的文件：启动引导文件、凭据、Helper broker 凭据、诊断开关、活动崩溃现场。 */
const PROTECTED_BASENAMES = new Set([
  "setting.json",
  "setting.json.lock",
  "credentials.json",
  ".credentials.json",
  ".tokens",
  "lcode-stdio-tap.json",
]);
const PROTECTED_PREFIXES = ["v2/crash/live"];

export function normalizeStorageRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

function isUnderPrefix(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function entryKeyBelow(path: string, prefix: string): string {
  const rest = path.slice(prefix.length + 1);
  const next = rest.split("/")[0];
  return next ? `${prefix}/${next}` : prefix;
}

export function classifyStoragePath(
  rawPath: string,
  context: StorageCatalogContext,
): StorageClassification {
  const path = normalizeStorageRelativePath(rawPath);
  // 原先把整份 home/v2 折叠到「其他」，无法看出占用来源；单独分类并保留逐子目录明细。
  // 自定义路径不代表旧数据可安全丢弃，优先于普通分类且不提供清理。
  if (context.rootId === "home" && context.hasCustomDataBaseDir && isUnderPrefix(path, "v2")) {
    return { categoryId: "legacyData", entryKey: entryKeyBelow(path, "v2") };
  }
  for (const rule of FILE_RULES) {
    if (rule.pattern.test(path)) {
      const entryKey = rule.entryKeySegments
        ? path.split("/").slice(0, rule.entryKeySegments).join("/")
        : path;
      return { categoryId: rule.categoryId, entryKey };
    }
  }
  for (const { prefix, categoryId } of PREFIX_INDEX) {
    if (isUnderPrefix(path, prefix)) {
      return { categoryId, entryKey: entryKeyBelow(path, prefix) };
    }
  }
  return { categoryId: "other", entryKey: path.split("/").slice(0, 2).join("/") };
}

export function getStorageCategoryCleanability(categoryId: StorageCategoryId): StorageCleanability {
  return CLEANABILITY[categoryId];
}

export function isProtectedStoragePath(rawPath: string): boolean {
  const path = normalizeStorageRelativePath(rawPath);
  const basename = path.split("/").at(-1) ?? path;
  if (PROTECTED_BASENAMES.has(basename)) return true;
  return PROTECTED_PREFIXES.some((prefix) => isUnderPrefix(path, prefix));
}

/** 文件规则所在的目录：清理时只需非递归枚举这些目录。 */
const FILE_RULE_SCOPES: Partial<Record<StorageCategoryId, string[]>> = {
  backups: ["cli/db", "cli", "v2"],
  logs: ["computer-use/run"],
};
/** 只靠文件规则、且需要递归枚举的类别：候选按分类过滤后只剩命中文件规则的路径。 */
const RECURSIVE_FILE_RULE_SCOPES: Partial<Record<StorageCategoryId, string[]>> = {
  subagentTranscripts: ["cli/agents"],
  // 原始产物仅作为同会话活动依据，clean plan 的分类过滤保证不会删除它们。
  mediaCache: ["cli/artifacts"],
};

export function getStorageCleanScopes(categoryId: StorageCategoryId): StorageCleanScope[] {
  // pnpm 引用与缓存格式由包管理器维护，不能把其存储文件当成普通缓存逐项删除。
  if (categoryId === "other" || categoryId === "pnpmCache" || CLEANABILITY[categoryId] === "none")
    return [];
  const recursive = [
    ...PREFIX_RULES[categoryId],
    ...(RECURSIVE_FILE_RULE_SCOPES[categoryId] ?? []),
  ].map((prefix) => ({ prefix, recursive: true }));
  const shallow = (FILE_RULE_SCOPES[categoryId] ?? []).map((prefix) => ({
    prefix,
    recursive: false,
  }));
  return [...recursive, ...shallow];
}
