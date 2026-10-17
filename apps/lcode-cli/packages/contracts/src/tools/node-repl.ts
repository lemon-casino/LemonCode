import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

const JsInputBaseShape = {
  // 同一模型 schema 同时服务 persistent core REPL 与 fresh-kernel Browser Use MCP；
  // 字段文案不能替任一执行边界承诺跨调用状态，生命周期由各自 tool description 说明。
  code: z.string().describe("JavaScript code to execute in the Node REPL session"),
  // 只写 optional 无法让模型判断何时覆盖默认值，长等待容易在副作用完成后超时。
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .optional()
    .describe(
      "Per-call timeout in milliseconds. You MUST provide this when the code is expected to run longer than 30000 ms, including all awaited operations. Set it to at least the estimated total runtime plus 15000 ms. If that exceeds the 120000 ms maximum, split the work into multiple calls.",
    ),
};
const JsUserTitleSchema = z
  .string()
  .min(1)
  .max(120)
  .describe(
    "Required short user-facing title in the user's language that describes the intended action without implementation terms such as js, JavaScript, or node_repl",
  );

/** js：在持久 REPL 里执行一段 JS 代码。 */
export const JsInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema,
  })
  .strict();
export type JsInput = z.infer<typeof JsInputSchema>;

// 新调用必须提供用户可读标题，但旧会话和第三方 provider 的历史调用可能没有该字段。
export const JsRuntimeInputSchema = z
  .object({
    ...JsInputBaseShape,
    title: JsUserTitleSchema.optional(),
  })
  .strict();
export type JsRuntimeInput = z.infer<typeof JsRuntimeInputSchema>;

export const JsOutputSchema = z
  .object({
    result: z.string().optional(),
    logs: z.string(),
    error: z
      .object({
        name: z.string(),
        message: z.string(),
        stack: z.string().optional(),
      })
      .optional(),
    // nodeRepl.emitImage 收集的图片（如 tab.screenshot 的截图）；formatModelContent 会转成 image 内容块给模型。
    images: z.array(z.object({ base64: z.string(), mimeType: z.string() }).strict()).optional(),
    // 模型显式 tab.screenshot() 原始 PNG 的 session artifact 绝对路径。
    browserScreenshotPaths: z.array(z.string()).optional(),
    responseMeta: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type JsOutput = z.infer<typeof JsOutputSchema>;

export const JsInputJsonSchema = toToolJsonSchema(JsInputSchema);
export const JsOutputJsonSchema = toToolJsonSchema(JsOutputSchema);

// 内置 MCP 的按需目录与执行宿主共用已有 node_repl 合同入口。
// 旧默认值与模型常用的 30 秒页面等待相同，发送等副作用成功后会在结果读取前被中止。
// 执行层和模型可见文案共用该常量，避免真实超时与 tools/list 描述漂移。
export const NODE_REPL_DEFAULT_TIMEOUT_MS = 60_000;

// MCP serverInfo 曾长期硬编码为 0.1.0，与插件发布版本分叉，导致宿主无法据此判断
// 实际加载的 Browser Use runtime。版本升级时该值应与 package.json 同步。
// 宿主自己的版本，不是 browser-use 插件的版本。把宿主抽成 @lcode/node-repl-host
// 时保留了这个数字：它一直就是 node_repl server 对外宣告的版本，换个数字等于无谓地改协议。
// 从此它随宿主契约（bridge 成员、工具面）变化，与两个插件各自的版本解耦。
// 升到 0.5.0：本次宿主契约本身变了（node_repl 从 browser-use 抽出成独立 seed 单元、
// 工具面随 CUA 的 node_repl SDK 重建调整），按上面这条规则该动。数字与 browser-use 0.5.0 相同
// 只是同源历史的巧合，不构成耦合——两者仍各自独立升版。
// 升到 0.6.0：工具面收敛到只剩 `js`，`js_reset` 与 `js_add_node_module_dir` 连同
// moduleDirs 能力一起删除。前者自 fresh-kernel 改造起就是固定返回成功的空操作，且"永不失败"
// 会让模型连续重复调用（重复调用会持续消耗预算）；后者
// 是把宿主职责推给模型——模型无法自行知道该传哪个 node_modules，能告诉它的只有 skill 文档，
// 而文档知道的路径宿主自己就能注入。两者实测调用量均为 0。宿主协议变了就得让 serverInfo 能被
// 据此识别，否则宿主无法区分自己连上的是哪一代工具面。
export const NODE_REPL_SERVER_VERSION = "0.6.0";

// node_repl 的底层能力是通用 JS，旧文案却没有声明模型路由边界，导致非浏览器任务
// 也会误选这个高权限工具。Browser Use 与 Computer Use 是合法入口，因此 server 与 tool 文案都要显式限域。
export const NODE_REPL_SERVER_INSTRUCTIONS =
  "Browser Use and Computer Use only. Use `js` to run JavaScript in a fresh Node-backed kernel only when " +
  "the corresponding official skill instructs you to control a browser or computer. Do not use this server for unrelated tasks, " +
  "including general-purpose JavaScript, filesystem, shell, package inspection, or data processing. " +
  `Calls default to a ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms timeout. ` +
  "Always provide `title` as a short user-facing description in the user's language. " +
  "Every `js` call starts fresh; reconstruct browser wrappers and recover persistent tabs from current BrowserControl facts.";

export const JS_TOOL_DESCRIPTION =
  "Browser Use and Computer Use only. Run JavaScript in a fresh Node-backed kernel with top-level await only as " +
  "instructed by the corresponding official skill to control a browser or computer. Do not use it as a general-purpose JavaScript runtime " +
  "or for filesystem, shell, package inspection, data processing, or other non-browser work. " +
  "Always provide the required `title` as a short " +
  "user-facing description in the user's language without implementation terms. If `timeout_ms` is omitted, execution times out " +
  `after ${NODE_REPL_DEFAULT_TIMEOUT_MS} ms. If the code may take more than 30000 ms including all awaited operations, you MUST set \`timeout_ms\` to at least the estimated total runtime plus 15000 ms; split the work into multiple calls if that exceeds the 120000 ms maximum. Use \`nodeRepl.cwd\`, \`nodeRepl.homeDir\`, \`nodeRepl.tmpDir\`, ` +
  "`nodeRepl.requestMeta`, `nodeRepl.setResponseMeta(meta)`, `nodeRepl.write(value)`, and " +
  "`await nodeRepl.emitImage(imageLike)`. Global bindings and module cache do not persist across calls. " +
  "For Computer Use SDK results, do not console.log/JSON.stringify the complete result or call " +
  "nodeRepl.emitImage yourself; the SDK submits the structured image/state result and you should " +
  "use nodeRepl.write for short text-only status. `get_app_state` is an explicit observation: " +
  "assign it to `const state`, always call `nodeRepl.write(state.text)`, and use " +
  "`state.state_id` plus `state.elements[*].index` for element targets; do not leave " +
  "get_app_state as the final expression or regex state_id from its text. " +
  "Metadata methods such as list_apps and list_windows may not return " +
  "action_sent; a missing field is not a failure, so inspect text or structuredContent. " +
  "Never use screenshot_display.bounds or app/window bounds as raster pixel coordinates; " +
  "x/y must be integer pixels inside the width/height of the returned raster. " +
  "Every Computer Use JavaScript call must start with the complete SDK bootstrap in the same cell " +
  "before agent.computerUse; never split bootstrap and action across calls. Never rely on agent, " +
  "runtime, browser, or imported bindings from an earlier call. " +
  "Import only `node:*` builtins and absolute `file://` URLs built from the official skill root, " +
  'for example `await import(pathToFileURL(join(root, "scripts", "client.mjs")).href)`; ' +
  "bare package specifiers do not resolve. Bootstrap the requested official capability in every call.";
