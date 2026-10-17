import { resolve } from "node:path";
import type { Plugin } from "vite";

/** 多个 HTML module script 会被合并；显式 entry 保证视频不等待完整 UI 依赖。 */
export function startupEntryPlugins(desktopRoot: string): Plugin[] {
  const entry = resolve(desktopRoot, "src/renderer/src/startup/bootstrap.ts");
  return [
    {
      name: "lcode-startup-independent-entry",
      config: (config) => {
        const input = config.build?.rollupOptions?.input;
        const entries =
          input && typeof input === "object" && !Array.isArray(input)
            ? input
            : {
                index:
                  typeof input === "string"
                    ? input
                    : resolve(desktopRoot, "src/renderer/index.html"),
              };
        return { build: { rollupOptions: { input: { ...entries, "startup-bootstrap": entry } } } };
      },
      transformIndexHtml: {
        order: "pre",
        handler(html, context) {
          if (context.server) return html;
          return html.replace(
            /\s*<script type="module" src="\.\/src\/startup\/bootstrap\.ts"><\/script>/u,
            "",
          );
        },
      },
    },
    {
      name: "lcode-startup-entry-script",
      transformIndexHtml: {
        order: "post",
        handler(_html, context) {
          if (context.server || !context.bundle || !context.filename?.endsWith("index.html"))
            return;
          const chunk = Object.values(context.bundle).find(
            (output) =>
              output.type === "chunk" &&
              output.facadeModuleId?.replaceAll("\\", "/") === entry.replaceAll("\\", "/"),
          );
          if (!chunk) throw new Error("Independent startup entry was not emitted");
          return [
            {
              tag: "script",
              attrs: { type: "module", src: `./${chunk.fileName}` },
              injectTo: "head-prepend",
            },
          ];
        },
      },
    },
  ];
}
