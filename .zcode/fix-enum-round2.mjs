// 第二轮枚举值回退：skillMetadata 联合 + hooks 族 source 描述符（一次性）
import fs from "node:fs";

const EDITS = [
  // skillMetadata 内联联合（与 CLI 保留的 SkillSource "zcode" 对齐）
  ["packages/shared/src/lcode-task-types-core.ts", [
    ['"agents" | "lcode" | "bundled" | "plugin" | "remote"', '"agents" | "zcode" | "bundled" | "plugin" | "remote"'],
  ]],
  // hooks 族：location.source 类型是保留的 SettingsDirectorySource
  ["packages/ui/src/store/hooksStore.ts", [
    ['"lcode"', '"zcode"'],
  ]],
  ["packages/ui/src/settings/HooksSection.tsx", [
    ['"lcode"', '"zcode"'],
  ]],
  ["packages/services/src/hooks/hooksService.ts", [
    ['"lcode"', '"zcode"'],
  ]],
  ["packages/services/src/hooks/workspaceHookSettingsModel.ts", [
    ['"lcode"', '"zcode"'],
  ]],
];

for (const [file, pairs] of EDITS) {
  let c = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const [from, to] of pairs) {
    const n = c.split(from).length - 1;
    if (n === 0) { console.log(`MISS: ${file} :: ${from}`); continue; }
    c = c.split(from).join(to);
    changed = true;
    console.log(`${file}: ${n} x ${from.slice(0, 40)}`);
  }
  if (changed) fs.writeFileSync(file, c);
}
console.log("done");
