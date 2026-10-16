import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ClaudeAuthDriver } from "./claude.js";
import { claudeGrant, claudeEnvironment } from "./claude-process.js";
test(
  "PC-05 Claude CLI routes through one owned HTTP dispatch and preserves upstream Retry-After",
  { timeout: 15000 },
  async (t) => {
    let posts = 0;
    const upstream = createServer((req, res) => {
      req.resume();
      posts++;
      res.writeHead(429, { "content-type": "application/json", "retry-after": "7" });
      res.end(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "fixture" } }),
      );
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const children: ReturnType<typeof spawn>[] = [];
    const driver = new ClaudeAuthDriver(
      (args, dir, additions) => {
        assert.ok(additions?.ANTHROPIC_BASE_URL?.startsWith("http://127.0.0.1:"));
        const code =
          'import readline from "node:readline";const input=readline.createInterface({input:process.stdin});input.once("line",async()=>{try {for(let i=0;i<2;i++){const res=await fetch(process.env.ANTHROPIC_BASE_URL+"/v1/messages",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({model:"fixture",messages:[]})});await res.text();} } finally {process.stdout.write(JSON.stringify({type:"result",is_error:true})+"\\n");input.close();}});';
        const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
          cwd: dir,
          env: { ...claudeEnvironment(dir), ...additions },
          windowsHide: true,
          stdio: "pipe",
        });
        children.push(child);
        return child;
      },
      undefined,
      async () => Response.json({}),
      async (_input, init) =>
        fetch(
          "http://127.0.0.1:" + (upstream.address() as AddressInfo).port + "/v1/messages",
          init,
        ),
    );
    t.after(async () => {
      await driver.dispose();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    });
    assert.equal(driver.routingSingleAttempt, true);
    let grant = claudeGrant({
      claudeAiOauth: {
        accessToken: "fixture",
        refreshToken: "fixture",
        expiresAt: Date.now() + 3600000,
      },
    });
    const response = await driver.fetch(
      new Request("https://api.anthropic.com/v1/messages", {
        method: "POST",
        body: JSON.stringify({
          model: "fixture",
          stream: true,
          max_tokens: 16,
          messages: [{ role: "user", content: "fixture" }],
        }),
      }),
      {
        routingSingleAttempt: true,
        read: async () => grant,
        write: async (next) => {
          grant = next;
        },
      },
    );
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "7");
    await response.text();
    assert.equal(posts, 1);
    await driver.dispose();
    assert.ok(children.every((child) => child.exitCode !== null || child.signalCode !== null));
  },
);
