import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { RemoteAssetNetworkPort } from "@lcode/server/remote/remoteAssetNetwork.js";

/** 只读安装包的平铺发行资源；复用原 manifest / SHA / cache 通路，不访问网络。 */
export function createBundledRemoteAssetNetwork(directory: string): RemoteAssetNetworkPort {
  if (!isAbsolute(directory)) throw new Error("bundled remote asset directory must be absolute");
  return {
    source: "bundled",
    fetch: async (input, init) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      signal?.throwIfAborted();
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (method !== "GET" && method !== "HEAD") return new Response(null, { status: 405 });
      let name: string;
      try {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        );
        name = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      } catch {
        return new Response(null, { status: 404 });
      }
      if (
        !/^(?:manifest-(?:linux|darwin)-(?:x64|arm64)\.json|remote-[a-z0-9-]+-[a-f0-9]{64}\.tar\.gz)$/u.test(
          name,
        )
      )
        return new Response(null, { status: 404 });
      const path = join(directory, name);
      try {
        signal?.throwIfAborted();
        const file = await lstat(path);
        if (!file.isFile() || !file.size) return new Response(null, { status: 404 });
        const headers = {
          "content-length": String(file.size),
          "content-type": name.endsWith(".json") ? "application/json" : "application/gzip",
        };
        if (method === "HEAD") return new Response(null, { headers });
        const bytes = await readFile(path);
        signal?.throwIfAborted();
        return new Response(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
          { headers },
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return new Response(null, { status: 404 });
        throw error;
      }
    },
  };
}
