// 验收 grep 复审：把残余 zcode 按保留类别分类，输出例外清单 Markdown 片段（一次性）
import { execFileSync } from "node:child_process";

const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const lines = git(["grep", "-I", "-i", "-n", "zcode"]).split("\n").filter(Boolean);

const CATS = [
  ["转义域名正则 / 旧数据字段键 / bizCode 误报 / 外部包名识别串", /zcode\\+\.z\\+\.ai|bizCode|zcode-cua|zcode\?:|zcode: lcode|zcode 渠道归因/],
  ["外部域名族 zcode.z.ai / zcode-plan 网关路径", /zcode\.z\.ai|zcode-plan/],
  ["上游指认 zai-org/ZCode", /zai-org\//],
  ["MCP 命名空间 com.zcode/*（含 Go 侧）", /com\.zcode/],
  ["插件市场 ID zcode-plugins-official", /zcode-plugins-official/],
  ["外部包名 zcode_cua / zcode-cua.server / zcode-api-key", /zcode_cua|zcode-cua\.server|zcode-api-key/],
  ["官网跨站契约 zcodeBridge / __zcodeLang__ / zcode-coding-plan-lang-change / zcode:coding-plan:embedded / 注入页 zcode-theme", /zcodeBridge|__zcodeLang__|zcode-coding-plan-lang-change|zcode:coding-plan:embedded|"zcode-theme"/],
  ["持久化枚举/数据标识 \"zcode\" / zcodeagentmcp / provider.zcode / model.zcode / localStorage:zcode-mcp-config / __zcode_internal", /"zcode"|zcodeagentmcp|provider\.zcode|model\.zcode|localStorage:zcode-mcp-config|__zcode_internal/],
  ["遥测 schema zcode.* 点分键与哈希输入", /"zcode\.|zcode:session_create:v1|zcode\.session/],
  ["stableIdPolicy 图 ID（zcode-feature-relationships / service.zcode-*）", /graphId: zcode-feature|service\.zcode-/],
  ["appId/生成器工具自身", /BIGMODEL_APP_ID|generate-third-party-notices|licenses\.mjs/],
  ["生成物/第三方原文/lockfile/补丁（不手改）", /pnpm-lock\.yaml|third-party\/|THIRD-PARTY-NOTICES|patches\/|workflow-runs|workflow-drafts/],
];

const buckets = new Map(CATS.map(([k]) => [k, new Map()]));
const unknown = new Map();
for (const line of lines) {
  const file = line.slice(0, line.indexOf(":"));
  if (/^(\.zcode\/|out\/|specs\/brand-migration-lcode\.md|\.zcode\/residual)/.test(file)) continue;
  const hit = CATS.find(([, re]) => re.test(line));
  const target = hit ? buckets.get(hit[0]) : unknown;
  const m = target.get(file) ?? 0;
  target.set(file, m + 1);
}

let md = "\n## 例外清单（`git grep -I -i zcode` 全仓残余，自动分类于迁移执行时）\n\n";
let total = 0;
for (const [cat, files] of buckets) {
  const n = [...files.values()].reduce((s, x) => s + x, 0);
  if (n === 0) continue;
  total += n;
  md += `### ${cat} —— ${n} 行 / ${files.size} 文件\n`;
  for (const [f, c] of [...files].sort()) md += `- ${f}（${c} 行）\n`;
  md += "\n";
}
if (unknown.size > 0) {
  total += [...unknown.values()].reduce((s, x) => s + x, 0);
  md += `### ⚠ 未分类（需人工处理）—— ${[...unknown.values()].reduce((s, x) => s + x, 0)} 行\n`;
  for (const [f, c] of unknown) md += `- ${f}（${c} 行）\n`;
  md += "\n";
}
console.log(`total residual lines: ${total}`);
console.log(`unclassified files: ${unknown.size}`);
if (unknown.size > 0) {
  for (const line of lines) {
    const file = line.slice(0, line.indexOf(":"));
    if (/^(\.zcode\/|out\/|specs\/brand-migration-lcode\.md)/.test(file)) continue;
    const hit = CATS.find(([, re]) => re.test(line));
    if (!hit) console.log(line.slice(0, 220));
  }
}
{
  const fs = await import("node:fs");
  fs.writeFileSync(".zcode/exceptions-draft.md", md);
}
