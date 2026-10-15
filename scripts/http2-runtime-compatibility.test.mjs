import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

test("remote prebuild/runtime and CLI target match the repository Node baseline and H2 engine requirement", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const node = (await read("mise.toml")).match(/^node\s*=\s*"([^"]+)"/m)[1];
  assert.ok(
    (await read("scripts/prepare-prebuilds.mjs")).includes(`const nodeVersion = "v${node}"`),
  );
  assert.ok(
    (await read("packages/lcode-server-cli/src/contracts.ts")).includes(
      `SERVER_RUNTIME_NODE_VERSION = "${node}"`,
    ),
  );
  assert.match(await read("apps/lcode-cli/packages/cli/scripts/build.mjs"), /target: "node24"/);
  const require = createRequire(new URL("../packages/provider-node/package.json", import.meta.url));
  const undici = require("undici/package.json");
  assert.equal(undici.version, "8.12.1");
  assert.equal(undici.engines.node, ">=22.19.0");
  for (const consumer of ["desktop", "services", "server"]) {
    const consumerRequire = createRequire(
      new URL(`../packages/${consumer}/package.json`, import.meta.url),
    );
    assert.equal(
      consumerRequire("undici/package.json").version,
      undici.version,
      `${consumer} external runtime must load the verified backend`,
    );
  }
});
