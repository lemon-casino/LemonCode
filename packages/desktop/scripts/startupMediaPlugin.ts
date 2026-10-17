import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { Plugin } from "vite";
import {
  STARTUP_MEDIA_FILES,
  readStartupMediaAssets,
  startupMediaDirectory,
} from "./startup-media-assets.mjs";

/** 开发与打包复用同一组仓库资源，不能再由环境开关生成空可用清单。 */
export function startupMediaPlugin(desktopRoot: string): Plugin {
  const directory = startupMediaDirectory(desktopRoot);
  let assets: ReturnType<typeof readStartupMediaAssets> | undefined;
  const readAssets = () => (assets ??= readStartupMediaAssets(directory));
  return {
    name: "lcode-bundled-startup-media",
    async config() {
      await readAssets();
      return {
        define: {
          __LCODE_STARTUP_MEDIA_FILES__: JSON.stringify(STARTUP_MEDIA_FILES),
        },
      };
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const name = request.url?.split("?")[0]?.slice("/startup-media/".length);
        if (
          !request.url?.startsWith("/startup-media/") ||
          !name ||
          !STARTUP_MEDIA_FILES.includes(name)
        )
          return next();
        try {
          const path = resolve(directory, name);
          const { size } = await stat(path);
          const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? "");
          const start = range ? Number(range[1]) : 0;
          const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
          if (start > end || start >= size) {
            response.statusCode = 416;
            response.end();
            return;
          }
          response.statusCode = range ? 206 : 200;
          response.setHeader(
            "Content-Type",
            name.endsWith(".json")
              ? "application/json"
              : name.endsWith(".jpg")
                ? "image/jpeg"
                : name.endsWith(".png")
                  ? "image/png"
                  : "video/mp4",
          );
          response.setHeader("Accept-Ranges", "bytes");
          response.setHeader("Content-Length", end - start + 1);
          if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
          if (request.method === "HEAD") {
            response.end();
            return;
          }
          const stream = createReadStream(path, { start, end });
          response.on("close", () => stream.destroy());
          stream.on("error", () => response.destroy());
          stream.pipe(response);
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
    async generateBundle() {
      for (const [fileName, source] of Object.entries(await readAssets())) {
        this.emitFile({
          type: "asset",
          fileName: `startup-media/${fileName}`,
          source,
        });
      }
    },
  };
}
