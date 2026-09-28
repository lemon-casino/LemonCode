// 更新 third-party 输入清单里的仓内路径与描述文字（外部 URL/包名仍保留，一次性）
import fs from "node:fs";

const FILES = [
  "third-party/copied-components.json",
  "third-party/embedded-components.json",
  "third-party/npm-overrides.json",
  "third-party/runtime/sources.json",
  "third-party/native-search/sources.json",
];
// 保留：外部域名/上游指认/外部包名
const PRESERVE = /zcode\.z\.ai|zai-org\/|zcode_cua|zcode-cua\.server|com\.zcode\/|zcode-plugins-official|zcode-api-key/;
const COMBINED = /ZCODE|ZCode|Zcode|zcode/g;
const MAP = { ZCODE: "LCODE", ZCode: "LCode", Zcode: "Lcode", zcode: "lcode" };
const TOKEN = /[A-Za-z0-9_$@.-]/;

for (const f of FILES) {
  let c;
  try { c = fs.readFileSync(f, "utf8"); } catch { continue; }
  let out = "";
  let last = 0;
  let n = 0;
  COMBINED.lastIndex = 0;
  let m;
  while ((m = COMBINED.exec(c)) !== null) {
    let a = m.index, b = m.index + m[0].length;
    while (a > 0 && TOKEN.test(c[a - 1])) a--;
    while (b < c.length && TOKEN.test(c[b])) b++;
    const token = c.slice(a, b);
    const window = c.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60);
    if (PRESERVE.test(token) || PRESERVE.test(window)) continue;
    out += c.slice(last, m.index) + MAP[m[0]];
    last = m.index + m[0].length;
    n++;
  }
  out += c.slice(last);
  if (n > 0) { fs.writeFileSync(f, out); console.log(`${f}: ${n} replacements`); }
}
