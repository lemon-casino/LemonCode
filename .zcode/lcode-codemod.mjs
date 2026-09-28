// ZCode → LCode 品牌迁移 codemod（一次性工具，迁移完成后可删除）
// 依据 specs/brand-migration-lcode.md 的保留清单实现"出现级"保留规则。
// 用法：node .zcode/lcode-codemod.mjs --move | --transform [--dry] | --audit
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry");
const MODE = process.argv.includes("--move") ? "move" : process.argv.includes("--audit") ? "audit" : "transform";

const COMBINED = /ZCODE|ZCode|Zcode|zcode/g;
const MAP = { ZCODE: "LCODE", ZCode: "LCode", Zcode: "Lcode", zcode: "lcode" };
const mapPath = (p) => p.replace(COMBINED, (m) => MAP[m]);

// ---- 保留规则 ----
const ENUM_LITERAL_FILES = new Set([
  "apps/zcode-cli/packages/contracts/src/commands/index.ts",
  "apps/zcode-cli/packages/contracts/src/skills/index.ts",
  "packages/shared/src/mcp-sync.ts",
  "packages/shared/src/settings-source.ts",
  "packages/shared/src/settings-sync.ts",
  "packages/shared/src/zcode-task-types-core.ts",
  "packages/shared/src/zcode-protocol-v4/telemetry.ts",
  // appId 字面量（远端已注册，保留）
  "apps/zcode-cli/packages/adapters/src/auth/bigmodel-oauth.ts",
  "packages/web/src/auth/webZaiOAuthConfig.ts",
]);
const TELEMETRY_DIR_PREFIXES = ["apps/zcode-cli/packages/telemetry/", "packages/services/src/telemetry/"];
const WEBVIEW_THEME_FILE = "packages/ui/src/settings/model-provider-section/codingPlanEmbeddedWebview.ts";
const CUA_PKG_PREFIX = "packages/zcode-cua/";

// 出现级保留：返回 true 表示该处匹配不改
function isPreserved(relFile, content, idx, matchLen, token, window) {
  const before = idx > 0 ? content[idx - 1] : "";
  const after = idx + matchLen < content.length ? content[idx + matchLen] : "";
  // 枚举/appId 字面量 "zcode"
  if (ENUM_LITERAL_FILES.has(relFile) && (before === '"' || before === "'") && before === after) return true;
  // 遥测点分键与哈希输入
  if (TELEMETRY_DIR_PREFIXES.some((p) => relFile.startsWith(p))) {
    if (token.startsWith("zcode.")) return true;
    if (window.includes("zcode:session_create:v1")) return true;
  }
  // 官网注入页主题键
  if (relFile === WEBVIEW_THEME_FILE && token.includes("zcode-theme")) return true;
  // 全局 token 规则
  if (token.includes("zcode.z.ai")) return true;
  if (token.includes("zcode-plugins-official")) return true;
  if (token.includes("zcodeagentmcp")) return true;
  if (token === "zcode_cua" && !relFile.startsWith(CUA_PKG_PREFIX)) return true;
  if (token.includes("zcode-cua.server")) return true;
  if (token.includes("zcode-api-key")) return true;
  if (token.endsWith("provider.zcode") || token.endsWith("model.zcode")) return true;
  if (token.includes("zcode-plan")) return true;
  if (token.includes("zcodeBridge") || token.includes("__zcodeLang__") || token.includes("zcode-coding-plan-lang-change")) return true;
  // 全局 window 规则
  if (window.includes("zai-org/")) return true;
  if (window.includes("localStorage:zcode-mcp-config")) return true;
  if (window.includes("zcode:coding-plan:embedded")) return true;
  return false;
}

const TOKEN_CHARS = /[A-Za-z0-9_$@.-]/;
function tokenAround(content, idx, len) {
  let a = idx;
  while (a > 0 && TOKEN_CHARS.test(content[a - 1])) a--;
  let b = idx + len;
  while (b < content.length && TOKEN_CHARS.test(content[b])) b++;
  return content.slice(a, b);
}

// ---- git helpers ----
const git = (args) => execFileSync("git", args, { cwd: ROOT, maxBuffer: 256 * 1024 * 1024, encoding: "buffer" });
const gitText = (args) => git(args).toString("utf8");
const tracked = () => gitText(["ls-files", "-z"]).split("\0").filter(Boolean);

const SKIP_FILE_RE = /(^|\/)(pnpm-lock\.yaml|THIRD-PARTY-NOTICES\.md)$/;
const SKIP_PREFIXES = ["patches/", "third-party/inventory.json", "third-party/copied-components.json", "out/", "specs/brand-migration-lcode.md"];
const BINARY_EXT = new Set([".png", ".icns", ".ico", ".woff", ".woff2", ".ttf", ".node", ".exe", ".dll", ".zip", ".gz", ".tgz", ".whl", ".pyd", ".so", ".dylib", ".bin", ".pdf", ".jpg", ".jpeg", ".gif", ".webp", ".mp4", ".wasm", ".a", ".lib", ".pdb"]);
const isSkippedPath = (p) => SKIP_FILE_RE.test(p) || SKIP_PREFIXES.some((s) => p === s || p.startsWith(s));
const looksBinary = (buf) => buf.subarray(0, 8192).includes(0);

function transformContent(rel, content) {
  let out = "";
  let last = 0;
  let changes = 0;
  COMBINED.lastIndex = 0;
  let m;
  while ((m = COMBINED.exec(content)) !== null) {
    const token = tokenAround(content, m.index, m[0].length);
    const window = content.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    if (isPreserved(rel, content, m.index, m[0].length, token, window)) continue;
    out += content.slice(last, m.index) + MAP[m[0]];
    last = m.index + m[0].length;
    changes++;
  }
  out += content.slice(last);
  return { text: out, changes };
}

if (MODE === "move") {
  const files = tracked();
  const changed = files.filter((p) => /zcode/i.test(p)).sort();
  const applied = [];
  const rebase = (p) => {
    let r = p;
    for (const [from, to] of [...applied].sort((a, b) => b[0].length - a[0].length)) {
      if (r === from) return to;
      if (r.startsWith(from + "/")) return to + r.slice(from.length);
    }
    return r;
  };
  let moved = 0;
  for (const old of changed) {
    const nw = mapPath(old);
    const cur = rebase(old);
    if (cur === nw) continue;
    if (!fs.existsSync(path.join(ROOT, cur))) {
      console.log(`SKIP(missing) ${cur} -> ${nw}`);
      continue;
    }
    fs.mkdirSync(path.dirname(path.join(ROOT, nw)), { recursive: true });
    execFileSync("git", ["mv", cur, nw], { cwd: ROOT });
    applied.push([old, nw]);
    moved++;
  }
  console.log(`moved ${moved} paths (from ${changed.length} candidates)`);
} else if (MODE === "transform" || MODE === "audit") {
  const files = tracked();
  let touched = 0;
  let totalChanges = 0;
  const residual = [];
  for (const rel of files) {
    if (isSkippedPath(rel)) continue;
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) continue;
    const buf = fs.readFileSync(path.join(ROOT, rel));
    if (looksBinary(buf)) continue;
    const content = buf.toString("utf8");
    COMBINED.lastIndex = 0;
    if (!COMBINED.test(content)) { COMBINED.lastIndex = 0; continue; }
    COMBINED.lastIndex = 0;
    if (MODE === "audit") { residual.push(rel); continue; }
    const { text, changes } = transformContent(rel, content);
    if (changes > 0) {
      if (!DRY) fs.writeFileSync(path.join(ROOT, rel), text);
      touched++;
      totalChanges += changes;
      if (touched <= 40 || DRY) console.log(`${changes}\t${rel}`);
    }
  }
  console.log(DRY ? `[dry] would change ${touched} files / ${totalChanges} occurrences` : `transformed ${touched} files / ${totalChanges} occurrences`);
  if (MODE === "audit") {
    console.log(`files still containing zcode: ${residual.length}`);
    for (const r of residual) console.log(`  ${r}`);
  }
}
