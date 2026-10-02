import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// 只注册既有 tsx，不下载、不构建，也不把公共包入口替换成生产内部实现。
const require = createRequire(import.meta.url);
const { register } = await import(pathToFileURL(require.resolve("tsx/esm/api")).href);
register();
