import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import {
  runtimeEnvironmentServiceActionParamsSchema,
  runtimeEnvironmentServiceActionResultSchema,
} from "@lcode/shared";
import type {
  ServiceOwnerAction,
  ServiceOwnerChannel,
  ServiceOwnerKey,
  ServiceOwnerRequest,
} from "../app/serviceStageOwner.js";
export type {
  ServiceOwnerAction,
  ServiceOwnerChannel,
  ServiceOwnerKey,
  ServiceOwnerRequest,
} from "../app/serviceStageOwner.js";

const MAX_BYTES = 32 * 1024;
const routeSchema = z
  .object({ endpoint: z.string().max(4096), secret: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
const requestSchema = z
  .object({
    action: z.enum(["start", "stop", "query"]),
    secret: routeSchema.shape.secret,
    params: runtimeEnvironmentServiceActionParamsSchema.extend({
      expectedGeneration: z.number().int().positive(),
    }),
  })
  .strict();
type Route = z.infer<typeof routeSchema>;
const keyOf = (key: ServiceOwnerKey) =>
  JSON.stringify([key.environmentId, key.serviceId, key.generation]);
const requestKey = (params: ServiceOwnerRequest): ServiceOwnerKey => ({
  environmentId: params.environmentId,
  serviceId: params.serviceId,
  generation: params.expectedGeneration,
});
const unavailable = () =>
  Object.assign(new Error("process-unknown: service owner channel unavailable"), {
    code: "process-unknown",
  });

/** 只转发给真实进程 owner；认证/断线/超时不是退出证明，不调用 kill 或重启服务。 */
export function createServiceOwnerChannel(
  dataDir: string,
  options: {
    owns(key: ServiceOwnerKey): boolean;
    handle(
      action: ServiceOwnerAction,
      params: ServiceOwnerRequest,
    ): Promise<import("@lcode/shared").RuntimeEnvironmentServiceActionResult>;
    requestTimeoutMs?: number;
  },
): ServiceOwnerChannel {
  const root = join(resolve(dataDir), "service-owner-routes");
  const namespace = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  const routes = new Map<string, Route>();
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let disposed = false;
  let endpoint: string | undefined;
  let socketDirectory: string | undefined;
  let opening: Promise<void> | undefined;
  const pathFor = (key: string) =>
    join(root, `${createHash("sha256").update(key).digest("hex")}.json`);
  function validEndpoint(value: string): boolean {
    if (process.platform === "win32")
      return (
        value.startsWith(`\\\\.\\pipe\\lcode-service-${namespace}-`) &&
        /^[a-f0-9]{32}$/u.test(value.slice(-32))
      );
    const base = join(tmpdir(), `lcode-service-${namespace}-`);
    return value.startsWith(base) && /^[a-zA-Z0-9]+\/owner\.sock$/u.test(value.slice(base.length));
  }
  async function readRoute(path: string): Promise<Route | undefined> {
    try {
      const stat = await lstat(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 8192 ||
        (process.platform !== "win32" && stat.mode & 0o077)
      )
        return undefined;
      const file = await open(path, "r");
      try {
        const current = await file.stat();
        if (current.ino !== stat.ino || current.size > 8192) return undefined;
        const buffer = Buffer.alloc(8193);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 8192) return undefined;
        const parsed = routeSchema.safeParse(JSON.parse(buffer.toString("utf8", 0, bytesRead)));
        return parsed.success && validEndpoint(parsed.data.endpoint) ? parsed.data : undefined;
      } finally {
        await file.close();
      }
    } catch {
      return undefined;
    }
  }
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(options.requestTimeoutMs ?? 15_000, () => socket.destroy());
    let bytes = 0;
    let chunks: Buffer[] = [];
    const consume = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        socket.destroy();
        return;
      }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      socket.off("data", consume);
      const input = Buffer.concat(chunks).toString("utf8");
      chunks = [];
      const work = (async () => {
        try {
          if (disposed) throw unavailable();
          const request = requestSchema.parse(JSON.parse(input.trim()));
          const key = requestKey(request.params);
          const route = routes.get(keyOf(key));
          if (
            !route ||
            !timingSafeEqual(Buffer.from(route.secret), Buffer.from(request.secret)) ||
            !options.owns(key)
          )
            throw unavailable();
          const result = runtimeEnvironmentServiceActionResultSchema.parse(
            await options.handle(request.action, request.params),
          );
          const payload = `${JSON.stringify(result)}\n`;
          if (Buffer.byteLength(payload) > MAX_BYTES) throw unavailable();
          if (!socket.destroyed) socket.end(payload);
        } catch {
          if (!socket.destroyed)
            socket.end(
              '{"status":"blocked","reason":"process-unknown: service owner unavailable"}\n',
            );
        }
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work));
    };
    socket.on("data", consume);
  });
  // listen 之后的 server 错误也 fail closed；绝不切换新 endpoint 并认领旧路由。
  server.on("error", () => {});
  async function ensureOpen(): Promise<void> {
    if (disposed) throw unavailable();
    opening ??= (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if ((await lstat(root)).isSymbolicLink()) throw unavailable();
      if (process.platform !== "win32") await chmod(root, 0o700);
      if (process.platform === "win32")
        endpoint = `\\\\.\\pipe\\lcode-service-${namespace}-${randomBytes(16).toString("hex")}`;
      else {
        socketDirectory = await mkdtemp(join(tmpdir(), `lcode-service-${namespace}-`));
        await chmod(socketDirectory, 0o700);
        endpoint = join(socketDirectory, "owner.sock");
      }
      await new Promise<void>((ready, reject) => {
        const failed = () => reject(unavailable());
        server.once("error", failed);
        server.listen(endpoint!, () => {
          server.off("error", failed);
          ready();
        });
      });
      if (process.platform !== "win32") await chmod(endpoint!, 0o600);
      if (disposed) throw unavailable();
    })();
    await opening;
  }
  async function removeKey(key: string): Promise<void> {
    const owned = routes.get(key);
    if (!owned) return;
    await withFileLock(pathFor(key), async () => {
      const current = await readRoute(pathFor(key));
      // CAS 清理：旧代/旧 channel 的退出不能删除后来 owner 发布的 route。
      if (current?.secret === owned.secret && current.endpoint === owned.endpoint)
        await rm(pathFor(key), { force: true });
    });
    routes.delete(key);
  }
  return {
    async publish(key) {
      await ensureOpen();
      if (!options.owns(key)) throw unavailable();
      const id = keyOf(key);
      await withFileLock(pathFor(id), async () => {
        if (disposed) throw unavailable();
        const current = await readRoute(pathFor(id));
        const previous = routes.get(id);
        if (
          current &&
          (current.endpoint !== previous?.endpoint || current.secret !== previous?.secret)
        )
          throw unavailable();
        // 已存在但损坏/不可读的路由也不覆盖，防止把无法验证的旧 owner 当成空闲。
        if (
          !current &&
          (await lstat(pathFor(id)).then(
            () => true,
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return false;
              throw error;
            },
          ))
        )
          throw unavailable();
        const route = previous ?? { endpoint: endpoint!, secret: randomBytes(32).toString("hex") };
        await atomicWritePrivateTextFile(pathFor(id), `${JSON.stringify(route)}\n`);
        routes.set(id, route);
      });
    },
    remove: (key) => removeKey(keyOf(key)),
    async request(action, params) {
      if (disposed) return undefined;
      const parsed = requestSchema.shape.params.safeParse(params);
      if (!parsed.success) return undefined;
      const route = await readRoute(pathFor(keyOf(requestKey(parsed.data))));
      if (!route) return undefined;
      const payload = `${JSON.stringify({ action, params: parsed.data, secret: route.secret })}\n`;
      if (Buffer.byteLength(payload) > MAX_BYTES) return undefined;
      return new Promise((resolveResult) => {
        const socket = createConnection(route.endpoint);
        sockets.add(socket);
        let size = 0;
        let chunks: Buffer[] = [];
        const timer = setTimeout(
          () => finish(undefined),
          options.requestTimeoutMs ?? (action === "query" ? 3000 : 15_000),
        );
        const finish = (
          value: import("@lcode/shared").RuntimeEnvironmentServiceActionResult | undefined,
        ) => {
          clearTimeout(timer);
          socket.destroy();
          sockets.delete(socket);
          resolveResult(value);
        };
        socket.once("connect", () => socket.write(payload));
        socket.once("error", () => finish(undefined));
        socket.once("close", () => finish(undefined));
        socket.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) return finish(undefined);
          chunks.push(chunk);
          if (!chunk.includes(10)) return;
          try {
            const result = runtimeEnvironmentServiceActionResultSchema.safeParse(
              JSON.parse(Buffer.concat(chunks).toString("utf8").trim()),
            );
            finish(result.success ? result.data : undefined);
          } catch {
            finish(undefined);
          }
          chunks = [];
        });
      });
    },
    async disposeAndWait() {
      disposed = true;
      await opening?.catch(() => {});
      for (const socket of sockets) socket.destroy();
      if (server.listening) await new Promise<void>((done) => server.close(() => done()));
      await Promise.all(pending);
      await Promise.all([...routes.keys()].map(removeKey));
      if (socketDirectory) await rm(socketDirectory, { recursive: true, force: true });
    },
  };
}
