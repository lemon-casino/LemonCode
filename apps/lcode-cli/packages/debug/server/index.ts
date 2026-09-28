import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { cors } from "hono/cors";
import { Hono } from "hono";
import { inspectTrace, listTraces } from "./analyzer.js";
import {
  createNetworkCaptureServiceFromEnv,
  disabledNetworkCaptureStatus,
  type NetworkCaptureService,
} from "./network-capture.js";
import { createObservationEventStream } from "./observation-events.js";
import type { ObservationOptions } from "./types.js";

interface DebugAppOptions {
  staticRoot?: string;
  networkCapture?: NetworkCaptureService;
}

interface DebugServerOptions extends Omit<DebugAppOptions, "networkCapture"> {
  host?: string;
  port?: number;
  networkCapture?: NetworkCaptureService | false;
}

export function createDebugApp(options: DebugAppOptions = {}): Hono {
  const app = new Hono();
  app.use("*", cors());

  app.get("/api/health", (context) =>
    context.json({
      ok: true,
      service: "lcode-debug",
    }),
  );

  app.get("/api/traces", async (context) =>
    context.json(await listTraces(queryToOptions(context.req.query()))),
  );

  app.get("/api/traces/:traceId", async (context) => {
    const traceId = context.req.param("traceId");
    return context.json(await inspectTrace(traceId, queryToOptions(context.req.query())));
  });

  app.get("/api/observations/events", (context) => {
    const stream = createObservationEventStream(queryToOptions(context.req.query()));
    return context.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
  });

  app.get("/api/network/status", (context) =>
    context.json(options.networkCapture?.getStatus() ?? disabledNetworkCaptureStatus()),
  );

  app.get("/api/network/requests", (context) => {
    const query = context.req.query();
    const limit = parsePositiveInteger(query.limit);
    const status = options.networkCapture?.getStatus() ?? disabledNetworkCaptureStatus();
    const requests =
      options.networkCapture?.listRequests({
        traceId: query.traceId || undefined,
        limit,
      }) ?? [];
    return context.json({ status, requests });
  });

  app.get("/api/network/ca.pem", async (context) => {
    const status = options.networkCapture?.getStatus();
    const path = status?.certificate.caCertPath;
    if (!path || !status.certificate.caCertAvailable) {
      return context.text("network capture CA certificate is not available", 404);
    }
    const certificate = await readFile(path, "utf8");
    return context.body(certificate, 200, {
      "Content-Type": "application/x-pem-file; charset=utf-8",
      "Content-Disposition": 'inline; filename="lcode-debug-ca.pem"',
    });
  });

  app.get("/api/network/events", (context) => {
    const stream = createNetworkEventStream(options.networkCapture);
    return context.body(stream, 200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
  });

  if (options.staticRoot && existsSync(options.staticRoot)) {
    app.use("/*", serveStatic({ root: options.staticRoot }));
    app.get("*", async (context) => {
      const index = await readFile(join(options.staticRoot ?? "", "index.html"), "utf8");
      return context.html(index);
    });
  }

  return app;
}

export function startDebugServer(options: DebugServerOptions = {}) {
  const port = options.port ?? 4174;
  const hostname = options.host ?? "127.0.0.1";
  const networkCapture =
    options.networkCapture === false
      ? undefined
      : options.networkCapture ?? createNetworkCaptureServiceFromEnv();
  const app = createDebugApp({ ...options, networkCapture });
  const server = serve({
    fetch: app.fetch,
    hostname,
    port,
  });
  if (networkCapture) {
    void networkCapture.start().catch(() => {
      // Startup failures are exposed through /api/network/status so the debug UI can keep running.
    });
    server.on("close", () => {
      void networkCapture.stop();
    });
  }
  return server;
}

function queryToOptions(query: Record<string, string>): ObservationOptions {
  return {
    sessionId: query.sessionId || undefined,
    logDir: query.logDir || undefined,
    dbPath: query.dbPath || undefined,
    eventPath: query.eventPath || undefined,
    projectId: query.projectId || undefined,
    limit: parsePositiveInteger(query.limit),
  };
}

function parsePositiveInteger(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function createNetworkEventStream(
  networkCapture: NetworkCaptureService | undefined,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const writeEvent = (type: string, data: unknown): Uint8Array =>
    encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  let unsubscribe: (() => void) | undefined;

  return new ReadableStream({
    start(controller) {
      if (!networkCapture) {
        controller.enqueue(writeEvent("status", disabledNetworkCaptureStatus()));
        return;
      }

      controller.enqueue(writeEvent("status", networkCapture.getStatus()));
      controller.enqueue(writeEvent("snapshot", networkCapture.listRequests()));
      unsubscribe = networkCapture.subscribe((event) => {
        if (event.type === "status") controller.enqueue(writeEvent("status", event.status));
        if (event.type === "snapshot") controller.enqueue(writeEvent("snapshot", event.requests));
        if (event.type === "request") controller.enqueue(writeEvent("request", event.request));
        if (event.type === "reset") controller.enqueue(writeEvent("reset", {}));
      });
    },
    cancel() {
      unsubscribe?.();
    },
  });
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  const staticRoot = resolve(process.cwd(), "dist");
  const networkCapture = createNetworkCaptureServiceFromEnv();
  networkCapture?.subscribe((event) => {
    if (event.type === "status" && event.status.running) {
      console.log(
        `network proxy listening on ${event.status.proxyUrl} (CA ${event.status.certificate.caCertPath})`,
      );
    }
  });
  const server = startDebugServer({
    staticRoot,
    port: parsePositiveInteger(process.env.PORT) ?? 4174,
    networkCapture,
  });
  server.on("listening", () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 4174;
    console.log(`debug listening on http://127.0.0.1:${port}`);
  });
}
