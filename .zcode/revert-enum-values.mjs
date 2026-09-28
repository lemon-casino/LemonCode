// 枚举值/外部契约使用点回退：与保留的 "zcode" 联合类型及远端注册值对齐（一次性）
// hooks 族 location.source 与 _meta/data.lcode 工具元数据键保持 "lcode"（双侧已同步改名），
// 旧数据兼容读在批次 2 补齐。
import fs from "node:fs";

const EDITS = [
  // MCP 同步/目录来源描述符（对应共享 McpSyncSource / SettingsDirectorySource 保留联合）
  ["packages/services/src/mcp-sync/mcpSyncService.ts", [
    ["source: \"lcode\"", "source: \"zcode\""],
    ["directorySource: \"lcode\"", "directorySource: \"zcode\""],
  ]],
  ["packages/desktop/src/main/mcpUserDirectory/index.ts", [
    ["directorySource: \"lcode\"", "directorySource: \"zcode\""],
  ]],
  ["packages/services/src/commands/commandsService.ts", [
    ["directorySource: \"lcode\"", "directorySource: \"zcode\""],
    ["descriptor.directorySource === \"lcode\"", "descriptor.directorySource === \"zcode\""],
  ]],
  ["packages/ui/src/lib/messageTelemetry.ts", [
    ["source?: \"agents\" | \"lcode\"", "source?: \"agents\" | \"zcode\""],
  ]],
  ["packages/ui/src/settings/CommandCard.tsx", [
    ["command.location.source === \"lcode\"", "command.location.source === \"zcode\""],
  ]],
  ["packages/ui/src/settings/ExternalAgentImportDialog.tsx", [
    ["case \"lcode\":", "case \"zcode\":"],
  ]],
  ["packages/ui/src/settings-sync/SettingsSyncSelectionStep.tsx", [
    ["case \"lcode\":", "case \"zcode\":"],
  ]],
  ["packages/ui/src/settings/McpServerList.tsx", [
    ["server.location.source === \"lcode\"", "server.location.source === \"zcode\""],
  ]],
  ["packages/ui/src/store/mcpStoreHelpers.ts", [
    ["directorySource !== \"lcode\"", "directorySource !== \"zcode\""],
  ]],
  ["packages/ui/src/store/mcpStoreMigration.ts", [
    ["server.location.source === \"lcode\"", "server.location.source === \"zcode\""],
  ]],
  ["packages/ui/src/settings/McpSettingsSection.tsx", [
    ["getEnabledMcpServersForLCode(\"lcode\")", "getEnabledMcpServersForLCode(\"zcode\")"],
  ]],
  // 外部契约：远端已注册的 appId 与渠道归因
  ["packages/services/src/oauth/providers/bigmodelProviderConfig.ts", [
    ["appId: \"lcode\"", "appId: \"zcode\""],
  ]],
  ["packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts", [
    ["salesChannel: request.salesChannel ?? \"lcode\"", "salesChannel: request.salesChannel ?? \"zcode\""],
    ["不显式标记会丢失 lcode 来源归因", "不显式标记会丢失 zcode 渠道归因（远端按注册值 zcode 识别，品牌更名不改远端注册值）"],
  ]],
  // 旧数据兼容读取边界：旧 config.json 字段前缀
  ["packages/services/src/model-provider/legacyLCodeConfigProviderReader.ts", [
    ["!key.toLowerCase().startsWith(\"lcode\")", "!key.toLowerCase().startsWith(\"zcode\")"],
  ]],
];

let files = 0;
for (const [file, pairs] of EDITS) {
  if (pairs.length === 0) continue;
  let c = fs.readFileSync(file, "utf8");
  let changed = false;
  for (const [from, to] of pairs) {
    if (!c.includes(from)) { console.log(`MISS: ${file} :: ${from}`); continue; }
    c = c.split(from).join(to);
    changed = true;
  }
  if (changed) { fs.writeFileSync(file, c); files++; console.log(`reverted ${file}`); }
}
console.log(`done: ${files} files`);
