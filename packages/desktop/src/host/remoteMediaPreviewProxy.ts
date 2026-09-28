import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { IFileService, IMediaPreviewService, MediaPreviewPreparation } from "@lcode/services";
import { getMediaPreviewFormat, type WindowHostAttachmentScope } from "@lcode/shared";
import {
  isPathWithinWorkspace,
  listen,
  parseRange,
  waitForDrainOrDisconnect,
  writeError,
} from "./remoteMediaPreviewProxyHelpers.js";

export { waitForDrainOrDisconnect } from "./remoteMediaPreviewProxyHelpers.js";

const MEDIA_ROUTE_PREFIX = "/__lcode_media/";
const DEFAULT_MAX_FILE_BYTES = 512 * 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_REQUESTS = 2;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const DEFAULT_IDLE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_TTL_MS = 2 * 60 * 60 * 1000;

type RemoteScope = Extract<WindowHostAttachmentScope, { kind: "remote" }>;

interface MediaLease {
  previewId: string;
  token: string;
  path: string;
  mediaType: string;
  size: number;
  scopeKey: string;
  expiresAt: number;
  lastAccessAt: number;
  activeRequests: number;
  staleLogged: boolean;
}

export interface RemoteMediaPreviewProxy {
  service: IMediaPreviewService;
  dispose(): Promise<void>;
}

interface MediaRequestSlot {
  release(): void;
}

export function createRemoteMediaPreviewProxy(options: {
  fileService: IFileService;
  scope: RemoteScope;
  maxFileBytes?: number;
  maxConcurrentRequests?: number;
  chunkBytes?: number;
  idleTtlMs?: number;
  ttlMs?: number;
  serverFactory?: () => Server;
  requestLimiter?: {
    tryAcquire(): boolean;
    release(): void;
    getState?(): { active: number; limit: number };
  };
  logger?: {
    debug(message: string, metadata?: unknown): void;
    warn(message: string, metadata?: unknown): void;
  };
  writeChunk?: (response: ServerResponse, chunk: Buffer) => boolean;
}): RemoteMediaPreviewProxy {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxConcurrentRequests = options.maxConcurrentRequests ?? DEFAULT_MAX_CONCURRENT_REQUESTS;
  const chunkBytes = Math.min(options.chunkBytes ?? DEFAULT_CHUNK_BYTES, DEFAULT_CHUNK_BYTES);
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const scopeKey = `${options.scope.workspaceIdentity.trim()}\0${options.scope.remoteSessionId}`;
  const leasesByToken = new Map<string, MediaLease>();
  const leasesByPreviewId = new Map<string, MediaLease>();
  const sockets = new Set<import("node:net").Socket>();
  const server = (options.serverFactory ?? (() => createServer()))();
  let disposed = false;
  let listeningPromise: Promise<void> | undefined;
  let lastBusyLogAt = 0;
  let lastExpiredLogAt = 0;

  function logBusy(lease: MediaLease, owner: "lease" | "host"): void {
    const now = Date.now();
    if (now - lastBusyLogAt < 10_000) return;
    lastBusyLogAt = now;
    const hostState = options.requestLimiter?.getState?.();
    options.logger?.warn("media-preview.range BUSY", {
      scopeKey,
      owner,
      active: owner === "lease" ? lease.activeRequests : hostState?.active,
      limit: owner === "lease" ? maxConcurrentRequests : hostState?.limit,
    });
  }

  function logStale(lease: MediaLease): void {
    if (lease.staleLogged) return;
    lease.staleLogged = true;
    options.logger?.warn("media-preview.range STALE", { scopeKey, previewId: lease.previewId });
  }

  function logExpired(): void {
    const now = Date.now();
    if (now - lastExpiredLogAt < 10_000) return;
    lastExpiredLogAt = now;
    options.logger?.debug("media-preview.lease EXPIRED", { scopeKey });
  }

  function acquireRequestSlot(lease: MediaLease): MediaRequestSlot | null {
    // 并发检查与递增之间一旦出现远端 await，多请求会同时越过 per-lease 上限。
    if (lease.activeRequests >= maxConcurrentRequests) {
      logBusy(lease, "lease");
      return null;
    }
    lease.activeRequests += 1;
    if (options.requestLimiter && !options.requestLimiter.tryAcquire()) {
      lease.activeRequests -= 1;
      logBusy(lease, "host");
      return null;
    }
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        lease.activeRequests = Math.max(0, lease.activeRequests - 1);
        options.requestLimiter?.release();
      },
    };
  }

  function isLeaseAlive(lease: MediaLease, now = Date.now()): boolean {
    if (disposed || lease.scopeKey !== scopeKey || lease.expiresAt <= now) {
      return false;
    }
    return lease.lastAccessAt + idleTtlMs > now;
  }

  function removeLease(lease: MediaLease): void {
    leasesByToken.delete(lease.token);
    leasesByPreviewId.delete(lease.previewId);
  }

  function buildUrl(token: string): string {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Remote media preview proxy is not listening");
    }
    return `http://127.0.0.1:${address.port}${MEDIA_ROUTE_PREFIX}${token}`;
  }

  async function resolveMediaPath(path: string): Promise<{
    path: string;
    mediaType: string;
    size: number;
  }> {
    const resolvedPath = await options.fileService.resolvePath({ path });
    if (!isPathWithinWorkspace(resolvedPath, options.scope.workspacePath)) {
      throw new Error("Media preview path is outside remote workspace");
    }
    const format = getMediaPreviewFormat(resolvedPath);
    if (!format) {
      throw new Error(`Unsupported media preview format: ${path}`);
    }
    const fileStat = await options.fileService.stat({ path: resolvedPath });
    if (fileStat.type !== "file" || typeof fileStat.size !== "number") {
      throw new Error(`Path is not a media file: ${path}`);
    }
    if (fileStat.size > maxFileBytes) {
      throw new Error(`Media file is too large for remote preview: ${path}`);
    }
    return { path: resolvedPath, mediaType: format.mediaType, size: fileStat.size };
  }

  async function prepare(params: {
    path: string;
    expectedKind: "video" | "audio";
  }): Promise<MediaPreviewPreparation> {
    const resolved = await resolveMediaPath(params.path);
    const format = getMediaPreviewFormat(resolved.path);
    if (!format || format.kind !== params.expectedKind) {
      throw new Error(`Unsupported media preview format: ${params.path}`);
    }
    await ensureListening();
    const now = Date.now();
    const lease: MediaLease = {
      previewId: randomUUID(),
      token: randomBytes(32).toString("hex"),
      path: resolved.path,
      mediaType: resolved.mediaType,
      size: resolved.size,
      scopeKey,
      expiresAt: now + ttlMs,
      lastAccessAt: now,
      activeRequests: 0,
      staleLogged: false,
    };
    leasesByToken.set(lease.token, lease);
    leasesByPreviewId.set(lease.previewId, lease);
    return {
      kind: "host-range-url",
      previewId: lease.previewId,
      mediaType: lease.mediaType,
      path: lease.path,
      size: lease.size,
      url: buildUrl(lease.token),
      urlExpiresAt: lease.expiresAt,
    };
  }

  const service: IMediaPreviewService = {
    prepare,
    async refreshPlaybackUrl({ previewId }) {
      const lease = leasesByPreviewId.get(previewId);
      if (!lease || !isLeaseAlive(lease)) {
        if (lease) removeLease(lease);
        throw new Error("Remote media preview lease expired");
      }
      const now = Date.now();
      leasesByToken.delete(lease.token);
      lease.token = randomBytes(32).toString("hex");
      leasesByToken.set(lease.token, lease);
      lease.lastAccessAt = now;
      lease.expiresAt = now + ttlMs;
      return { url: buildUrl(lease.token), expiresAt: lease.expiresAt };
    },
    async release({ previewId }) {
      const lease = leasesByPreviewId.get(previewId);
      if (lease) removeLease(lease);
    },
  };

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("request", (request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      writeError(response, error instanceof Error ? error.message : String(error), 500);
    });
  });

  return {
    service,
    async dispose() {
      if (disposed) return;
      disposed = true;
      leasesByToken.clear();
      leasesByPreviewId.clear();
      if (!listeningPromise) return;
      await listeningPromise.catch(() => undefined);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };

  async function ensureListening(): Promise<void> {
    if (!listeningPromise) {
      listeningPromise = listen(server);
    }
    await listeningPromise;
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (!requestUrl.pathname.startsWith(MEDIA_ROUTE_PREFIX)) {
      writeError(response, "Not found", 404);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      writeError(response, "Method not allowed", 405);
      return;
    }
    const token = requestUrl.pathname.slice(MEDIA_ROUTE_PREFIX.length);
    const lease = leasesByToken.get(token);
    if (!lease || !isLeaseAlive(lease)) {
      if (lease) removeLease(lease);
      logExpired();
      writeError(response, "Media preview lease expired", 404);
      return;
    }
    const range = parseRange(request.headers.range, lease.size);
    if (range === "invalid") {
      response.setHeader("Content-Range", `bytes */${lease.size}`);
      writeError(response, "Invalid media range", 416);
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? Math.max(0, lease.size - 1);
    const length = lease.size === 0 ? 0 : end - start + 1;
    const requestSlot =
      request.method === "GET" && length > 0 ? acquireRequestSlot(lease) : undefined;
    if (request.method === "GET" && length > 0 && !requestSlot) {
      response.setHeader("Retry-After", "1");
      writeError(response, "Too many media range requests", 429);
      return;
    }
    let aborted = false;
    const markAborted = () => {
      aborted = true;
    };
    request.once("aborted", markAborted);
    response.once("close", () => {
      if (!response.writableFinished) markAborted();
    });
    try {
      const currentStat = await options.fileService.stat({ path: lease.path });
      if (currentStat.type !== "file" || currentStat.size !== lease.size) {
        removeLease(lease);
        logStale(lease);
        writeError(response, "Remote media file changed during preview", 409);
        return;
      }
      const headers: Record<string, string> = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Disposition": "inline",
        "Content-Length": String(length),
        "Content-Type": lease.mediaType,
      };
      if (range) headers["Content-Range"] = `bytes ${start}-${end}/${lease.size}`;
      response.writeHead(range ? 206 : 200, headers);
      lease.lastAccessAt = Date.now();
      if (request.method === "HEAD" || length === 0) {
        response.end();
        return;
      }

      let offset = start;
      while (!aborted && offset <= end) {
        const requestedLength = Math.min(chunkBytes, end - offset + 1);
        const chunk = await options.fileService.readFileRange({
          path: lease.path,
          offset,
          length: requestedLength,
        });
        if (chunk.length !== requestedLength) {
          removeLease(lease);
          logStale(lease);
          throw new Error("Remote media source changed during requested range");
        }
        offset += chunk.length;
        const buffer = Buffer.from(chunk);
        const accepted = options.writeChunk
          ? options.writeChunk(response, buffer)
          : response.write(buffer);
        if (!accepted) {
          const drainState = await waitForDrainOrDisconnect(request, response);
          if (drainState === "closed") {
            aborted = true;
            options.logger?.debug("media-preview.range CLOSED", { scopeKey });
            break;
          }
        }
      }
      if (!aborted) {
        const completedStat = await options.fileService.stat({ path: lease.path });
        if (completedStat.type !== "file" || completedStat.size !== lease.size) {
          removeLease(lease);
          logStale(lease);
          throw new Error("Remote media file changed during preview");
        }
        response.end();
      }
    } catch (error) {
      if (!response.destroyed) response.destroy(error instanceof Error ? error : undefined);
    } finally {
      request.removeListener("aborted", markAborted);
      requestSlot?.release();
    }
  }
}
