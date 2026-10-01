import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { normalizeGitBackupOssConfig } from "./gitBackup.js";
import { uploadToOss, testOssConnection } from "./gitBackupOssClient.js";

const config = {
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret",
  bucket: "fixture-bucket",
  region: "cn-hangzhou",
};

test("OSS endpoint, encoded path and V1 signature use the same logical resource", async () => {
  const now = Date.UTC(2026, 0, 2);
  const key = "backups/a #?测试/data.enc";
  let calls = 0;
  const mock: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(
      String(url),
      `https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/${key.split("/").map(encodeURIComponent).join("/")}`,
    );
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("host"), null);
    const date = new Date(now).toUTCString();
    const signature = createHmac("sha1", config.accessKeySecret)
      .update(`PUT\n\napplication/octet-stream\n${date}\n/${config.bucket}/${key}`)
      .digest("base64");
    assert.equal(headers.get("authorization"), `OSS ${config.accessKeyId}:${signature}`);
    return new Response(null, { status: 200 });
  };
  assert.equal(
    (
      await uploadToOss(config, key, Buffer.from("fixture"), undefined, {
        fetch: mock,
        now: () => now,
      })
    ).ok,
    true,
  );
  assert.equal(calls, 1);
});

test("HTTP failures throw and HEAD connection test never writes objects", async () => {
  const calls: string[] = [];
  const mock: typeof fetch = async (url, init) => {
    calls.push(init?.method ?? "");
    if (init?.method === "HEAD") {
      assert.equal(String(url), "https://fixture-bucket.oss-cn-hangzhou.aliyuncs.com/");
      assert.equal(init.body, undefined);
      return new Response(null, { status: 200 });
    }
    return new Response("fixture failure", { status: 403 });
  };
  await assert.rejects(
    uploadToOss(config, "data.enc", Buffer.from("fixture"), undefined, { fetch: mock }),
    /HTTP 403/,
  );
  assert.deepEqual(await testOssConnection(config, { fetch: mock }), { ok: true });
  assert.deepEqual(calls, ["PUT", "HEAD"]);
  const denied = await testOssConnection(config, {
    fetch: async () => new Response(null, { status: 403 }),
  });
  assert.equal(denied.ok, false);
  assert.match(denied.error ?? "", /HTTP 403/);
});

test("request timeout and network errors fail", async () => {
  const blocked: typeof fetch = async (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  await assert.rejects(
    uploadToOss(config, "data.enc", Buffer.from("fixture"), undefined, {
      fetch: blocked,
      timeoutMs: 5,
    }),
    /timed out/,
  );
  assert.equal(
    (
      await testOssConnection(config, {
        fetch: async () => {
          throw new Error("fixture network failure");
        },
      })
    ).ok,
    false,
  );
});

test("transport errors never expose signing headers or credentials", async () => {
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    throw new Error(
      `fixture failure ${config.accessKeySecret} ${new Headers(init?.headers).get("authorization")}`,
    );
  };
  await assert.rejects(
    uploadToOss(config, "data.enc", Buffer.from("fixture"), undefined, { fetch }),
    (error) => {
      assert.equal((error as Error).message, "OSS PUT request failed");
      return true;
    },
  );
  const result = await testOssConnection(config, { fetch });
  assert.equal(result.error, "OSS HEAD request failed");
});

test("an injected transport returning after timeout cannot report success", async () => {
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    await new Promise<void>((resolve) =>
      init?.signal?.addEventListener("abort", () => resolve(), { once: true }),
    );
    return new Response(null, { status: 200 });
  };
  await assert.rejects(
    uploadToOss(config, "data.enc", Buffer.from("fixture"), undefined, { fetch, timeoutMs: 5 }),
    /timed out/,
  );
});

test("configuration rejects endpoint injection and unsafe prefixes", () => {
  assert.equal(normalizeGitBackupOssConfig(config).region, "oss-cn-hangzhou");
  assert.equal(
    normalizeGitBackupOssConfig({ ...config, region: "oss-cn-hangzhou" }).region,
    "oss-cn-hangzhou",
  );
  for (const region of [
    "https://fixture.invalid",
    "oss-cn-hangzhou@fixture.invalid/",
    "cn-hangzhou/path",
    " cn-hangzhou?x",
  ])
    assert.throws(() => normalizeGitBackupOssConfig({ ...config, region }));
  for (const pathPrefix of ["../secret", "/root", "a//b", "a/..", "a#b", "a?b", "a\\b"])
    assert.throws(() => normalizeGitBackupOssConfig({ ...config, pathPrefix }));
  for (const bucket of ["ab", "-bucket", "Bucket", "bucket.invalid", "bucket@fixture.invalid"])
    assert.throws(() => normalizeGitBackupOssConfig({ ...config, bucket }));
});
