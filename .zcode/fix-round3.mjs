// 第三轮修复：legacy 链式访问、NUL 污染文件、被 gitignore 的本地测试文件（一次性）
import fs from "node:fs";

// 1) legacy 读取器里对旧数据字段的链式访问（保留旧字段名）
const legacy = "packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts";
let c = fs.readFileSync(legacy, "utf8");
let n = 0;
for (const [from, to] of [
  ["model.lcode.reasoning", "model.zcode.reasoning"],
  ["model.lcode?.reasoning", "model.zcode?.reasoning"],
  ["provider.lcode.", "provider.zcode."],
  ["provider.lcode?.", "provider.zcode?."],
]) {
  const k = c.split(from).length - 1;
  if (k > 0) { c = c.split(from).join(to); n += k; console.log(`${legacy}: ${k} x ${from}`); }
}
fs.writeFileSync(legacy, c);

// 2) 被 git 判为二进制（含 NUL）的文件：按字节替换导入说明符
const nulFile = "packages/ui/src/hooks/useWorkflowRunNodeResult.ts";
{
  const buf = fs.readFileSync(nulFile);
  const from = Buffer.from("@zcode/shared/zcode-protocol-v4", "latin1");
  const to = Buffer.from("@lcode/shared/lcode-protocol-v4", "latin1");
  const idx = buf.indexOf(from);
  if (idx >= 0) {
    fs.writeFileSync(nulFile, Buffer.concat([buf.subarray(0, idx), to, buf.subarray(idx + from.length)]));
    console.log(`${nulFile}: import specifier fixed at ${idx}`);
  } else {
    console.log(`${nulFile}: no @zcode specifier found (check manually)`);
  }
}

// 3) 用户 gitignore(lib/) 覆盖的本地测试文件
const local = "packages/ui/src/lib/composerRecent.test.ts";
if (fs.existsSync(local)) {
  let t = fs.readFileSync(local, "utf8");
  const before = t;
  t = t.split('"@zcode/').join('"@lcode/').split("@zcode/").join("@lcode/");
  if (t !== before) { fs.writeFileSync(local, t); console.log(`${local}: imports fixed`); }
} else {
  console.log(`${local}: not present`);
}
console.log("done");
