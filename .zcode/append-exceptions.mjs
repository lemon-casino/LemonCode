// 把生成的例外清单追加进决策 spec（一次性）
import fs from "node:fs";

const draft = fs.readFileSync(".zcode/exceptions-draft.md", "utf8");
const specPath = "specs/brand-migration-lcode.md";
const spec = fs.readFileSync(specPath, "utf8");
const marker = "## 例外清单（批次 1 后实测登记）";
const idx = spec.indexOf(marker);
const before = spec.slice(0, idx);
const after =
  marker +
  "\n\n" +
  draft.trim() +
  "\n\n（例外清单由 `.zcode/gen-exceptions.mjs` 按保留类别自动生成；品牌验收 grep 以本清单为排除集，未分类为 0 即全部残余均有登记原因。）\n";
fs.writeFileSync(specPath, before + after);
console.log("spec exceptions appended");
