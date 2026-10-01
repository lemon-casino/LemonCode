import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import type { GitBackupMinioConfig } from "./gitBackup.js";
import { testMinioConnection, uploadToMinio } from "./gitBackupMinioClient.js";

const config: GitBackupMinioConfig = {
  endpoint: "https://minio.fixture.invalid",
  accessKeyId: "fixture-id",
  accessKeySecret: "fixture-secret/+==",
  bucket: "fixture-bucket",
  region: "us-east-1",
};
const now = Date.UTC(2026, 0, 2, 3, 4, 5);
const datetime = "20260102T030405Z";

function verifySignature(
  url: string,
  init: RequestInit | undefined,
  credentials = config,
  payload = Buffer.alloc(0),
) {
  const headers = new Headers(init?.headers);
  const parsed = new URL(url);
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const payloadHash = createHash("sha256").update(payload).digest("hex");
  const scope = `20260102/${credentials.region || "us-east-1"}/s3/aws4_request`;
  assert.equal(headers.get("host"), null);
  assert.equal(headers.get("x-amz-date"), datetime);
  assert.equal(headers.get("x-amz-content-sha256"), payloadHash);
  // 独立按 S3 SigV4 规则重建实际传输 URI 和 Host（含端口），不复用签名器。
  const canonicalRequest = [
    init?.method,
    parsed.pathname,
    "",
    `host:${parsed.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${datetime}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    datetime,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const dateKey = createHmac("sha256", `AWS4${credentials.accessKeySecret}`)
    .update("20260102")
    .digest();
  const regionKey = createHmac("sha256", dateKey)
    .update(credentials.region || "us-east-1")
    .digest();
  const serviceKey = createHmac("sha256", regionKey).update("s3").digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  assert.equal(
    headers.get("authorization"),
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  );
}

function trackedResponse(status: number, onCancel: () => void) {
  return new Response(
    new ReadableStream({
      cancel: onCancel,
    }),
    { status },
  );
}

test("PUT uses independent SigV4 verification, payload hash and injected raw Buffer transport", async () => {
  const data = Buffer.from("padding-fixture-padding").subarray(8, 15);
  let calls = 0;
  let cancelled = 0;
  const mock: typeof fetch = async (input, init) => {
    calls++;
    assert.equal(String(input), "https://minio.fixture.invalid/fixture-bucket/data.enc");
    assert.equal(init?.method, "PUT");
    assert.equal(init?.body, data);
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("content-type"), "application/x-fixture");
    verifySignature(String(input), init, config, data);
    return trackedResponse(201, () => cancelled++);
  };
  assert.deepEqual(
    await uploadToMinio(config, "data.enc", data, "application/x-fixture", {
      fetch: mock,
      now: () => now,
    }),
    { ok: true, statusCode: 201, objectKey: "data.enc" },
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test("Unicode, spaces, reserved characters and literal escapes are encoded once per key segment", async () => {
  const key = "backups/测试 a+ #?%2F!'()*/data.enc";
  const encodedKey = "backups/%E6%B5%8B%E8%AF%95%20a%2B%20%23%3F%252F%21%27%28%29%2A/data.enc";
  const data = Buffer.from("fixture");
  await uploadToMinio(config, key, data, undefined, {
    now: () => now,
    fetch: async (input, init) => {
      assert.equal(String(input), `${config.endpoint}/${config.bucket}/${encodedKey}`);
      assert.equal(new Headers(init?.headers).get("content-type"), "application/octet-stream");
      verifySignature(String(input), init, config, data);
      return new Response(null, { status: 200 });
    },
  });
});

test("HTTP IP endpoints, custom ports and explicit region are preserved in the signed host", async () => {
  for (const endpoint of [
    "http://127.0.0.1:9000",
    "https://minio.fixture.invalid:9443/",
    "http://[::1]:9000",
  ]) {
    const custom = { ...config, endpoint, bucket: "fixture.bucket", region: "eu-west-2" };
    const data = Buffer.from("fixture");
    await uploadToMinio(custom, "a/b.enc", data, undefined, {
      now: () => now,
      fetch: async (input, init) => {
        assert.equal(String(input), `${new URL(endpoint).origin}/fixture.bucket/a/b.enc`);
        verifySignature(String(input), init, custom, data);
        return new Response(null, { status: 200 });
      },
    });
  }
});

test("empty region defaults to us-east-1 rather than guessing from endpoint", async () => {
  const custom = { ...config, endpoint: "https://s3.eu-west-2.amazonaws.com", region: "" };
  await uploadToMinio(custom, "data.enc", Buffer.alloc(0), undefined, {
    now: () => now,
    fetch: async (input, init) => {
      verifySignature(String(input), init, custom);
      return new Response(null, { status: 200 });
    },
  });
});

test("connection test signs HEAD bucket, has no payload or writes, and cancels the response", async () => {
  let calls = 0;
  let cancelled = 0;
  assert.deepEqual(
    await testMinioConnection(config, {
      now: () => now,
      fetch: async (input, init) => {
        calls++;
        assert.equal(String(input), "https://minio.fixture.invalid/fixture-bucket");
        assert.equal(init?.method, "HEAD");
        assert.equal(init?.body, undefined);
        assert.equal(init?.redirect, "error");
        assert.ok(init?.signal);
        assert.equal(new Headers(init?.headers).get("content-type"), null);
        verifySignature(String(input), init);
        return trackedResponse(200, () => cancelled++);
      },
    }),
    { ok: true },
  );
  assert.equal(calls, 1);
  assert.equal(cancelled, 1);
});

test("invalid endpoint origins are rejected before contacting injected transport", async () => {
  let calls = 0;
  const mock: typeof fetch = async () => {
    calls++;
    return new Response(null);
  };
  for (const endpoint of [
    "",
    "not-a-url",
    "ftp://minio.fixture.invalid",
    "https://fixture-id:fixture-secret@minio.fixture.invalid",
    "https://minio.fixture.invalid/s3",
    "https://minio.fixture.invalid?token=fixture-secret",
    "https://minio.fixture.invalid#fixture-secret",
    "https://minio.fixture.invalid:99999",
    "https://minio.fixture.invalid\\s3",
    "https://minio. fixture.invalid",
  ]) {
    await assert.rejects(
      uploadToMinio({ ...config, endpoint }, "data.enc", Buffer.alloc(0), undefined, {
        fetch: mock,
      }),
      /MinIO endpoint/,
    );
    const result = await testMinioConnection({ ...config, endpoint }, { fetch: mock });
    assert.equal(result.ok, false);
    assert.ok(!result.error?.includes("fixture-secret"));
  }
  assert.equal(calls, 0);
});

test("credentials, bucket, region and prefix must pass the public MinIO validator", async () => {
  let calls = 0;
  const mock: typeof fetch = async () => {
    calls++;
    return new Response(null);
  };
  const invalid: Partial<GitBackupMinioConfig>[] = [
    { accessKeyId: "" },
    { accessKeyId: "fixture\nid" },
    { accessKeySecret: "" },
    { accessKeySecret: "  " },
    { accessKeySecret: "fixture\nsecret" },
    { accessKeySecret: "x".repeat(257) },
    { bucket: "Bucket" },
    { bucket: "fixture..bucket" },
    { bucket: "127.0.0.1" },
    { region: "https://fixture.invalid" },
    { region: "us-east-1/path" },
    { region: "   " },
    { pathPrefix: "../secret" },
  ];
  for (const patch of invalid) {
    await assert.rejects(
      uploadToMinio({ ...config, ...patch }, "data.enc", Buffer.alloc(0), undefined, {
        fetch: mock,
      }),
      /Invalid MinIO/,
    );
  }
  assert.equal(calls, 0);
});

test("unsafe object key segments are rejected before signing or transport", async () => {
  let calls = 0;
  for (const key of [
    "",
    "/data.enc",
    "a//b",
    "a/",
    ".",
    "..",
    "a/./b",
    "a/../b",
    "a\u0000b",
    "\ud800",
  ]) {
    await assert.rejects(
      uploadToMinio(config, key, Buffer.alloc(0), undefined, {
        fetch: async () => {
          calls++;
          return new Response(null);
        },
      }),
      /Invalid MinIO object key/,
    );
  }
  assert.equal(calls, 0);
});

test("HTTP errors and redirects reject, cancel bodies and never report response details", async () => {
  for (const status of [301, 302, 307, 308, 400, 403, 500]) {
    let calls = 0;
    let cancelled = 0;
    await assert.rejects(
      uploadToMinio(config, "data.enc", Buffer.from("fixture"), undefined, {
        fetch: async (_input, init) => {
          calls++;
          assert.equal(init?.redirect, "error");
          return trackedResponse(status, () => cancelled++);
        },
      }),
      { message: `MinIO PUT failed (HTTP ${status})` },
    );
    assert.equal(calls, 1);
    assert.equal(cancelled, 1);
  }
  const denied = await testMinioConnection(config, {
    fetch: async () => new Response(`Authorization ${config.accessKeySecret}`, { status: 403 }),
  });
  assert.deepEqual(denied, { ok: false, error: "MinIO HEAD failed (HTTP 403)" });
});

test("redirect, network and signing failures expose neither credentials nor signing headers", async () => {
  for (const failure of [
    new TypeError(
      `redirect refused Authorization: ${config.accessKeyId} ${config.accessKeySecret}`,
    ),
    new Error(
      `network failed ${config.endpoint} X-Amz-Date AWS4-HMAC-SHA256 ${config.accessKeySecret}`,
    ),
  ]) {
    await assert.rejects(
      uploadToMinio(config, "data.enc", Buffer.from("fixture"), undefined, {
        fetch: async () => {
          throw failure;
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "MinIO PUT request failed");
        assert.equal(error.cause, undefined);
        return true;
      },
    );
    assert.deepEqual(
      await testMinioConnection(config, {
        fetch: async () => {
          throw failure;
        },
      }),
      { ok: false, error: "MinIO HEAD request failed" },
    );
  }
  await assert.rejects(
    uploadToMinio(config, "data.enc", Buffer.alloc(0), "invalid\nheader", {
      fetch: async () => {
        assert.fail("invalid header must not reach transport");
      },
    }),
    { message: "MinIO PUT request failed" },
  );
});

test("transport abort rejects without exposing its reason", async () => {
  await assert.rejects(
    uploadToMinio(config, "data.enc", Buffer.alloc(0), undefined, {
      fetch: async () => {
        throw new DOMException(config.accessKeySecret, "AbortError");
      },
    }),
    { message: "MinIO PUT request aborted" },
  );
});

test("timeout aborts the injected transport and never reports success", async () => {
  const blocked: typeof fetch = async (_input, init) =>
    new Promise((_resolve, reject) => {
      assert.ok(init?.signal);
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  await assert.rejects(
    uploadToMinio(config, "data.enc", Buffer.from("fixture"), undefined, {
      fetch: blocked,
      timeoutMs: 10,
    }),
    { message: "MinIO PUT request timed out" },
  );
  assert.deepEqual(await testMinioConnection(config, { fetch: blocked, timeoutMs: 10 }), {
    ok: false,
    error: "MinIO HEAD request timed out",
  });
});

test("a late response after abort is cancelled and cannot turn timeout into success", async () => {
  let cancelled = 0;
  await assert.rejects(
    uploadToMinio(config, "data.enc", Buffer.alloc(0), undefined, {
      timeoutMs: 10,
      fetch: async (_input, init) => {
        assert.ok(init?.signal);
        await new Promise<void>((resolve) =>
          init.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        return trackedResponse(200, () => cancelled++);
      },
    }),
    { message: "MinIO PUT request timed out" },
  );
  assert.equal(cancelled, 1);
});

test("timeout during response cleanup cannot report success", async () => {
  await assert.rejects(
    uploadToMinio(config, "data.enc", Buffer.alloc(0), undefined, {
      timeoutMs: 10,
      fetch: async (_input, init) =>
        new Response(
          new ReadableStream({
            cancel: async () => {
              assert.ok(init?.signal);
              await new Promise<void>((resolve) =>
                init.signal?.addEventListener("abort", () => resolve(), { once: true }),
              );
            },
          }),
          { status: 200 },
        ),
    }),
    { message: "MinIO PUT request timed out" },
  );
});

test("body cancellation failures reject with sanitized errors", async () => {
  await assert.rejects(
    uploadToMinio(config, "data.enc", Buffer.alloc(0), undefined, {
      fetch: async () =>
        trackedResponse(200, () => {
          throw new Error(`Authorization ${config.accessKeySecret}`);
        }),
    }),
    { message: "MinIO PUT request failed" },
  );
});
