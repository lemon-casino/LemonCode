// 更新 native-search sources.json 的输入哈希（输入脚本仅品牌改名，一次性）
import fs from "node:fs";
import crypto from "node:crypto";

const p = "third-party/native-search/sources.json";
const j = JSON.parse(fs.readFileSync(p, "utf8"));
for (const f of Object.keys(j.inputs)) {
  const h = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  if (h !== j.inputs[f]) {
    console.log("update", f);
    j.inputs[f] = h;
  }
}
fs.writeFileSync(p, `${JSON.stringify(j, null, 2)}\n`);
console.log("inputs updated");
