// roots.ts 的 source 描述符回退：与保留的 CustomCommandSource/SkillSource "zcode" 联合对齐（一次性）
import fs from "node:fs";

for (const p of [
  "apps/lcode-cli/packages/adapters/src/commands/roots.ts",
  "apps/lcode-cli/packages/adapters/src/skills/roots.ts",
]) {
  let c = fs.readFileSync(p, "utf8");
  const needle = ', "lcode",';
  const n = c.split(needle).length - 1;
  c = c.split(needle).join(', "zcode",');
  fs.writeFileSync(p, c);
  console.log(`${p}: ${n} replaced`);
}
