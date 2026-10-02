import { parseDocument } from "yaml";
import type { ProjectMemoryReviewDraft } from "@lcode/contracts";
import { assertSafeReviewFileName, MemoryReviewError } from "./review-common.js";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u;
const FRONTMATTER_NODE_LIMIT = 256;
const CONTROL_KEYS = new Set([
  "hooks",
  "hook",
  "commands",
  "command",
  "permissions",
  "permission",
  "systemprompt",
  "developerprompt",
  "toolcalls",
  "toolallowlist",
  "agents",
  "skills",
  "scheduler",
  "automation",
]);
const ALLOWED_MEMORY_SCOPES = new Set(["project", "workspace"]);
const EXECUTION_TYPES = new Set(["system", "global", "machine", "host", "runtime", "developer"]);
const OBVIOUS_SECRET_PATTERN =
  /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|password)\s*[:=]\s*["']?[^\s"'`]{8,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}|\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{16,}/iu;

/** 语义可信度交给独立复核；路径、配置控制和明显凭据不允许被“AI同意”豁免。 */
export function assertReviewVerificationCandidates(
  draft: ProjectMemoryReviewDraft,
  root: string,
): void {
  const targets = new Set<string>();
  const sourceIds = new Set(draft.sources.map((source) => source.id));
  for (const item of draft.items) {
    assertSafeReviewFileName(item.fileName, root);
    const key = item.fileName.toLowerCase();
    if (
      targets.has(key) ||
      !item.content.trim() ||
      !item.reason.trim() ||
      new Set(item.sourceIds).size !== item.sourceIds.length ||
      item.sourceIds.some((id) => !sourceIds.has(id))
    )
      throw new MemoryReviewError("invalid_response");
    targets.add(key);
    const before = draft.sources.find(
      (source) => source.kind === "memory" && source.reference === item.fileName,
    );
    if ((item.expectedHash !== null && !before) || (item.expectedHash === null && before)) {
      throw new MemoryReviewError("invalid_target");
    }
    if (hasObviousReviewSecret(item.content) || hasObviousReviewSecret(item.reason)) {
      throw new MemoryReviewError("invalid_response");
    }
    assertNonExecutableFrontmatter(item.content);
  }
}

export function hasObviousReviewSecret(value: string): boolean {
  return OBVIOUS_SECRET_PATTERN.test(value.normalize("NFKC"));
}

function assertNonExecutableFrontmatter(content: string): void {
  const normalized = content.replace(/^\uFEFF/u, "");
  if (!normalized.startsWith("---\n") && !normalized.startsWith("---\r\n")) return;
  const match = FRONTMATTER_PATTERN.exec(normalized);
  if (!match) throw new MemoryReviewError("invalid_response");
  let value: unknown;
  try {
    const document = parseDocument(match[1]!, { schema: "core" });
    if (document.errors.length || document.warnings.length)
      throw new MemoryReviewError("invalid_response");
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new MemoryReviewError("invalid_response");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MemoryReviewError("invalid_response");
  const queue: unknown[] = [value];
  for (let index = 0; index < queue.length; index++) {
    if (queue.length > FRONTMATTER_NODE_LIMIT) throw new MemoryReviewError("budget_exceeded");
    const node = queue[index];
    if (!node || typeof node !== "object") continue;
    for (const [rawKey, entry] of Object.entries(node)) {
      const key = rawKey
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[_\s-]/gu, "");
      if (
        CONTROL_KEYS.has(key) ||
        (key === "scope" &&
          (typeof entry !== "string" || !ALLOWED_MEMORY_SCOPES.has(entry.toLowerCase()))) ||
        (key === "type" && typeof entry === "string" && EXECUTION_TYPES.has(entry.toLowerCase()))
      ) {
        throw new MemoryReviewError("invalid_response");
      }
      if (entry !== null && typeof entry === "object") queue.push(entry);
    }
  }
}
