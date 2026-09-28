// 修复 baseUrlMatch 正则里被误改的转义域名（字面量替换，一次性）
import fs from "node:fs";
const p = "config/provider/lcode-builtin.json";
const needle = "lcode" + "\\\\.z\\\\.ai"; // 文件中的字面字节: lcode\\.z\\.ai
const repl = "zcode" + "\\\\.z\\\\.ai";
let c = fs.readFileSync(p, "utf8");
const n = c.split(needle).length - 1;
c = c.split(needle).join(repl);
fs.writeFileSync(p, c);
console.log("replaced:", n);
