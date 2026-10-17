import { build } from "esbuild";
import { resolve } from "node:path";

// 测试入口随实际 CLI/REPL 产物上传到隔离目录；不携带服务器地址或凭据。
for (const [entry, outfile] of [
  ["runtime-memory", "memory-lab"],
  ["runtime-memory-rpc", "memory-rpc-lab"],
])
  await build({
    entryPoints: [`packages/server/test/${entry}.fixture.ts`],
    outfile: `.artifacts/${outfile}.mjs`,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: ["koffi"],
    alias: {
      "@lcode/contracts/plugins": resolve(
        "apps/lcode-cli/packages/contracts/dist/plugins/index.js",
      ),
    },
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
