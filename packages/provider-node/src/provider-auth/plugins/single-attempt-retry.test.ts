import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPluginAuthFixtureDriver } from "../plugins.js";
test("PC-05 Zed 401 remints auth but cannot hide the second inference POST", async (t) => {
  let posts = 0,
    mints = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.setHeader("content-type", "application/json");
    if (req.url === "/models")
      res.end(
        JSON.stringify({
          models: [{ id: "fixture", provider: "anthropic", max_token_count: 64000 }],
        }),
      );
    else if (req.url === "/client/llm_tokens") {
      mints++;
      res.end(JSON.stringify({ token: "fixture-token" }));
    } else {
      posts++;
      res.writeHead(401, { "retry-after": "8" });
      res.end(JSON.stringify({ error: { message: "fixture denied" } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  for (const single of [false, true]) {
    const driver = createPluginAuthFixtureDriver(
      "zed",
      "http://127.0.0.1:" + (server.address() as AddressInfo).port,
    )!;
    try {
      const context = {
        ...(single ? { routingSingleAttempt: true as const } : {}),
        read: async () => ({
          type: "oauth" as const,
          access: "fixture",
          refresh: JSON.stringify({ userId: "fixture" }),
        }),
        write: async () => {},
      };
      const [model] = await driver.models(context);
      const before = posts,
        beforeMints = mints;
      const response = await driver.fetch(
        new Request(model!.baseURL + "/messages", {
          method: "POST",
          body: JSON.stringify({
            model: model!.id,
            messages: [{ role: "user", content: "fixture" }],
            stream: true,
            max_tokens: 16,
          }),
          headers: { "content-type": "application/json" },
        }),
        context,
      );
      assert.equal(response.status, 401);
      await response.text();
      assert.equal(posts - before, single ? 1 : 2);
      assert.equal(
        mints - beforeMints,
        1,
        "the catalog already minted the initial token; renewal remains independent from inference allowance",
      );
      if (single) assert.equal(response.headers.get("retry-after"), "8");
    } finally {
      await driver.dispose?.();
    }
  }
});
