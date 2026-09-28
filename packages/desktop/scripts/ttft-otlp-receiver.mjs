// 本地验收接收器：保留最终 OTLP 解码证据，不拦截内部埋点调用。
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
const require = createRequire(
  new URL("../../../apps/lcode-cli/packages/telemetry/package.json", import.meta.url),
);
const { opentelemetry } = require("@opentelemetry/otlp-transformer/build/src/generated/root.js");
const unzip = promisify(gunzip);
const records = [];
const server = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/reset") {
    records.length = 0;
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/records") {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(records));
    return;
  }
  try {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error("receiver body limit");
      chunks.push(chunk);
    }
    let body = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") body = await unzip(body);
    const codec =
      req.url === "/v1/traces"
        ? opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest
        : opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest;
    records.push({
      path: req.url,
      receivedAt: Date.now(),
      data: codec.toObject(codec.decode(body), { longs: String, bytes: String }),
    });
    if (records.length > 512) records.shift();
    if (req.url === "/v1/traces" && Number(process.argv[3]) > 0)
      await delay(Math.min(Number(process.argv[3]), 60000));
    res.writeHead(200);
    res.end();
  } catch (error) {
    res.writeHead(400);
    res.end(String(error));
  }
});
server.listen(Number(process.argv[2] ?? 14318), "127.0.0.1", () =>
  console.log(`OTLP receiver ready:${server.address().port}`),
);
