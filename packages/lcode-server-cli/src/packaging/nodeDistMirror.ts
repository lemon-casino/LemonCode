/**
 * Node dist 下载源的唯一解析点（本包内）。
 *
 * 与 `.gitlab/ci/00-workflow.yml` 的 `LCODE_NODE_DIST_MIRROR` CI 变量、
 * `scripts/prepare-prebuilds.mjs` 的 `nodeDistBase()`、
 * `scripts/cua-helper-sea-base.mjs` 的 `DEFAULT_MIRROR` 是同一个约定和同一个默认值。
 * 四处必须保持一致——CI 变量会覆盖
 * 代码默认值，两者一旦不同，改代码默认值在 CI 里就等于没改。
 *
 * `stageCli.ts` 与 `scripts/prepare-prebuilds.mjs` 都硬编码
 * `https://nodejs.org/dist`，而 macOS CI runner 连不上它（`UND_ERR_CONNECT_TIMEOUT`，10s）。
 * prepare-prebuilds 和 stage:remote-assets 任务
 * 都栽在这条路上；平时靠"缓存命中就不联网"侥幸绕过。
 *
 * 单独成模块而不是留在 stageCli.ts：后者末尾是顶层 `await main()`，import 即执行，
 * 无法在测试里引用。
 */
export const DEFAULT_NODE_DIST_BASE = "https://cdn.npmmirror.com/binaries/node";

export function resolveNodeDistBase(env: NodeJS.ProcessEnv = process.env): string {
  const mirror = env.LCODE_NODE_DIST_MIRROR?.trim();
  return (mirror || DEFAULT_NODE_DIST_BASE).replace(/\/+$/u, "");
}
