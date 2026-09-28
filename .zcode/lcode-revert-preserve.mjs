// 保留项回退脚本：修复 codemod 文件级规则使用旧路径导致的误改（一次性工具）
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const gitText = (args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const files = gitText(["ls-files", "-z"]).split("\0").filter(Boolean);

const ENUM_FILES = new Set([
  "apps/lcode-cli/packages/contracts/src/commands/index.ts",
  "apps/lcode-cli/packages/contracts/src/skills/index.ts",
  "packages/shared/src/mcp-sync.ts",
  "packages/shared/src/settings-source.ts",
  "packages/shared/src/settings-sync.ts",
  "packages/shared/src/zcode-task-types-core.ts",
  "packages/shared/src/lcode-protocol-v4/telemetry.ts",
  "apps/lcode-cli/packages/adapters/src/auth/bigmodel-oauth.ts",
  "packages/web/src/auth/webZaiOAuthConfig.ts",
]);
const TELEMETRY_PREFIXES = ["apps/lcode-cli/packages/telemetry/", "packages/services/src/telemetry/"];

let edits = 0;
for (const rel of files) {
  const p = `${ROOT}/${rel}`;
  let c;
  try { c = fs.readFileSync(p, "utf8"); } catch { continue; }
  let n = c;
  // A. com.zcode/* MCP 命名空间（含 Go 侧，保留）
  if (n.includes("com.lcode")) n = n.replaceAll("com.lcode", "com.zcode");
  // B. 遥测点分键与哈希输入（历史数据可比性，保留）
  if (TELEMETRY_PREFIXES.some((x) => rel.startsWith(x))) {
    n = n.replaceAll('"lcode.', '"zcode.');
    n = n.replaceAll("lcode:session_create:v1", "zcode:session_create:v1");
  }
  // C. 持久化枚举值与 OAuth appId 字面量
  if (ENUM_FILES.has(rel)) n = n.replaceAll('"lcode"', '"zcode"');
  if (n !== c) {
    fs.writeFileSync(p, n);
    edits++;
    console.log(`reverted\t${rel}`);
  }
}
console.log(`done: ${edits} files reverted`);
