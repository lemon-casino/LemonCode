// 从 @lcode/core 根 barrel 导入会让 esbuild 追踪具有顶层副作用的 Agent/tool 模块，
// 把 Bash registry、subagent 和 runtime 一起打进官方插件。Browser 发布物只能依赖窄 subpath。
import { setupBrowserRuntime as setupCoreBrowserRuntime } from "@lcode/core/browser-client";
import { readNodeReplBrowserRuntimeBridge } from "@lcode/node-repl-host/runtime-bridge";

export async function setupBrowserRuntime(input: {
  globals: Record<PropertyKey, unknown>;
}): Promise<void> {
  const bridge = readNodeReplBrowserRuntimeBridge(input.globals);
  bridge.assertAvailable();
  setupCoreBrowserRuntime({
    globals: input.globals as Record<string, unknown>,
    transport: bridge,
    documentationRoot: bridge.documentationRoot,
    assertAvailable: bridge.assertAvailable,
  });
}
