import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

// 使用 CLI 的公开入口和真实 executor；只替换执行端口，不发送模型请求或创建 run。
const source = String.raw`
import { builtInTools, createToolExecutor, createToolRegistry, PermissionService } from '@lcode/core';
import { createSessionId, SessionEventType } from '@lcode/contracts';
const registry = createToolRegistry();
registry.register(builtInTools.find(tool => tool.metadata.name === 'EvalWorkflowSnippet'));
const events = [];
let executions = 0;
const executor = createToolExecutor({
  registry, sessionId: createSessionId(), permissionService: new PermissionService(),
  mode: 'yolo', workingDirectory: process.cwd(),
  emitEvent: async event => { events.push(event); },
  dynamicWorkflowSnippetPort: { evalSnippet: async () => {
    executions++;
    return { kind: 'completed', artifact: { recovered: true }, logs: [], logsTruncated: false };
  } },
});
const rows = [];
for (const [index, input] of [{}, {code:'return { recovered: true };', path:'/'}, {code:'return { recovered: true };'}].entries()) {
  const toolCallId = 'snippet-browser-' + index;
  const result = await executor.execute({id:toolCallId, name:'EvalWorkflowSnippet', input});
  const terminal = events.find(event => event.type === SessionEventType.ToolCallResult && event.payload.toolCallId === toolCallId);
  rows.push({
    kind:'toolCall', rowId:index + 1, turnId:'snippet-fixture-turn', createdAt:1, createdAtSeq:index + 1,
    toolCallId, toolName:'EvalWorkflowSnippet', inputText:JSON.stringify(input), status:result.success ? 'success' : 'error',
    ...(result.success ? {output:{text:result.output.response, display:terminal.payload.result.display}} : {error:{code:result.error.code, message:result.error.message}}),
  });
}
process.stdout.write(JSON.stringify({rows, executions}));
`;

export async function snippetBrowserData() {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", source],
    {
      cwd: fileURLToPath(new URL("../../../apps/lcode-cli/packages/core/", import.meta.url)),
      windowsHide: true,
    },
  );
  return JSON.parse(stdout);
}
