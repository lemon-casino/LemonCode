// Bootstrap public API surface.

export * from "./app/create-app.js";
export type {
  ListLCodeSessionsOptions,
  PromptInput,
  ResolveLatestSessionOptions,
  ResumeOptions,
  RunLCodeProtocolAgentOptions,
  SendInputOptions,
  SendInputResult,
  SetLocaleResult,
  SteerTurnOptions,
  SubmitPromptOptions,
  UserPromptInput,
  LCodeApp,
  LCodeAppOptions,
  LCodeModelOption,
} from "./app/types.js";
export * from "./auth-login.js";
export {
  inspectLCodeCustomCommand,
  listLCodeCustomCommands,
  loadLCodeCustomCommand,
} from "./custom-commands.js";
export type {
  InspectLCodeCustomCommandOptions,
  ListLCodeCustomCommandsOptions,
  LCodeCustomCommandInspection,
} from "./custom-commands.js";
export { createModelAdapter } from "./model-factory.js";
export type { CreateModelAdapterOptions } from "./model-factory.js";
export { startProcessProviderRegistryRuntime } from "./app/process-provider-registry-runtime.js";
export type { ProcessProviderRegistryRuntimeOptions } from "./app/process-provider-registry-runtime.js";
export {
  addLCodePluginMarketplace,
  getLCodePluginsOverview,
  installLCodeMarketplacePlugin,
  listLCodePlugins,
  removeLCodePluginMarketplace,
  resolveLCodePlugins,
  setLCodePluginEnabled,
  uninstallLCodeMarketplacePlugin,
  updateLCodeMarketplacePlugin,
  updateLCodePluginMarketplace,
  validateLCodePluginPath,
} from "./plugins.js";
export type {
  AddLCodeMarketplaceOptions,
  InstallLCodeMarketplacePluginOptions,
  ListLCodePluginsOptions,
  RemoveLCodeMarketplaceOptions,
  ResolveLCodePluginsOptions,
  SetLCodePluginEnabledOptions,
  SetLCodePluginEnabledResult,
  UninstallLCodeMarketplacePluginOptions,
  UpdateLCodeMarketplaceOptions,
  UpdateLCodeMarketplacePluginOptions,
  ValidateLCodePluginPathOptions,
  LCodeAvailablePluginData,
  LCodeInstalledPluginData,
  LCodeMarketplaceSummaryData,
  LCodeMarketplaceUpdateData,
  LCodePluginInstallData,
  LCodePluginUpdateData,
  LCodePluginsOverviewData,
} from "./plugins.js";
export { runLCodeProtocolAgent } from "./lcode-protocol-entrypoint.js";
// Exposed for the CLI's --output-format stream-json: it needs the same event
// shape the protocol server emits, rather than inventing a second one.
export { mapSessionEvent } from "./lcode-protocol/session-mapper.js";
export { prepareLCodeTelemetryEnv, shutdownLCodeTelemetry } from "./telemetry-bootstrap.js";
export type { SessionTranscriptMessage, SessionTranscriptPart } from "./session-transcript.js";
export { listLCodeSessions, resolveLatestSession } from "./sessions.js";
export { inspectLCodeSkill, listLCodeSkills } from "./skills.js";
export type {
  InspectLCodeSkillOptions,
  ListLCodeSkillsOptions,
  LCodeSkillInspection,
} from "./skills.js";
// Exposed for the CLI's headless slash routing: it must decide "is this a real
// custom command?" with the *same* reserved-name gate the app facade's
// customCommandPromptResolver applies, or the two disagree and a reserved name
// reaches the model as literal prompt text. See prompt-command.ts.
export { isReservedLCodeSlashCommandName } from "./slash-command-surface.js";
export {
  grantWorkspaceHookTrust,
  inspectWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
} from "./workspace-hook-trust-cli.js";
export type {
  WorkspaceHookTrustCliItem,
  WorkspaceHookTrustCliStatus,
  WorkspaceHookTrustCliTarget,
} from "./workspace-hook-trust-cli.js";
