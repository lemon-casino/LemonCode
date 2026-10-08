import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Tinypool } from "tinypool";

// 原型污染只发生在这个独立测试进程中；探针仅使用无副作用的启动参数和环境标记。
const mode = process.argv[2];
const pollutedProperties =
  mode === "worker"
    ? {
        execArgv: ["--no-warnings"],
        env: { ...process.env, LCODE_SECURITY_POLLUTION_PROBE: "unexpected" },
      }
    : { name: "missing-export", filename: "missing-worker.mjs" };
let pool;
try {
  for (const [key, value] of Object.entries(pollutedProperties)) {
    Object.defineProperty(Object.prototype, key, { value, configurable: true, writable: true });
  }
  pool = new Tinypool({
    filename: fileURLToPath(new URL("./dependency-security-worker.mjs", import.meta.url)),
    minThreads: 0,
    maxThreads: 1,
  });
  const result = await pool.run(null, {});
  assert.equal(result.pollutedEnvironment, null);
  assert.equal(result.execArgv.includes("--no-warnings"), false);
} finally {
  for (const key of Object.keys(pollutedProperties)) delete Object.prototype[key];
  await pool?.destroy();
}
