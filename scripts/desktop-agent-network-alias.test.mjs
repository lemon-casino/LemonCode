import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { resolveBuildAliases } from "../apps/lcode-cli/packages/cli/scripts/build.mjs";

const requireFromCli = createRequire(
  new URL("../apps/lcode-cli/packages/cli/scripts/build.mjs", import.meta.url),
);
const { build } = requireFromCli("esbuild");

test("Agent build resolves and executes the public network proxy contract", async () => {
  const result = await build({
    stdin: {
      contents:
        'export { isNetworkProxyUrl, proxyProfilesSchema } from "@lcode/shared/network-proxy";',
    },
    alias: resolveBuildAliases(),
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    logLevel: "silent",
  });
  const contract = await import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
  assert.equal(contract.isNetworkProxyUrl("socks5://test-user:test-pass@127.0.0.1:1080"), true);
  assert.equal(contract.isNetworkProxyUrl("ftp://127.0.0.1:1080"), false);
  assert.equal(
    contract.proxyProfilesSchema.safeParse([
      { id: "test-proxy", name: "Test", httpProxy: "https://127.0.0.1:8443" },
    ]).success,
    true,
  );
});
