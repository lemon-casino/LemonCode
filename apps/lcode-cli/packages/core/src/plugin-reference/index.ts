// Plugin 对话引用（@ Plugin capability hint）核心模块出口。
export {
  extractPluginReferences,
  isValidPluginStableId,
  MAX_PLUGIN_REFERENCES_PER_TURN,
  type ExtractPluginReferencesResult,
} from "./references.js";
export {
  buildPluginReferenceCatalog,
  findPluginReferenceCatalogEntry,
} from "./catalog.js";
export {
  buildPluginReferenceReminderBody,
  MAX_PLUGIN_REFERENCE_MCP_SERVERS,
  MAX_PLUGIN_REFERENCE_REMINDER_BYTES,
  MAX_PLUGIN_REFERENCE_SKILLS,
  MAX_PLUGIN_REFERENCE_SUBAGENTS,
  type BuildPluginReferenceReminderInput,
  type BuildPluginReferenceReminderResult,
  type LivePluginMcpServer,
  type LivePluginSkill,
  type LivePluginSubagent,
  type PluginReferenceReminderDiagnostics,
  type PluginReferenceSkipReason,
} from "./reminder.js";
