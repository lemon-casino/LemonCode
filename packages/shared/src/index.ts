export type {
  FileBinaryPreview,
  FileEntry,
  FileMediaPreview,
  FileStat,
  FileTextSlice,
  FileWatchEvent,
  WorkspaceFileEntry,
  SystemInfo,
  AppSettings,
  ElectronReleaseChannel,
  IntegratedTerminalShellDialect,
  IntegratedTerminalShellOption,
  IntegratedTerminalShellSelection,
  Locale,
  LocalePreference,
  LCodeInteractionBehavior,
  TabId,
  TabState,
  ResourceUsageCategory,
  ResourceUsageBaseGroupKey,
  ResourceUsageProcess,
  HostResourceUsageProcess,
  ResourceUsageSnapshot,
  RemoteTargetSnapshot,
  RemoteWorkspaceSessionEntry,
  PersistedWorkspaceSessionEntry,
} from "./protocol.js";
export type { WorkspacePurpose } from "./workspacePurpose.js";
export * from "./localProjects.js";
export * from "./worktreePolicy.js";
export * from "./worktreeExecution.js";
export * from "./worktreeIntegration.js";
export * from "./taskTitle.js";
export * from "./runtimeEnvironment.js";
export { DEFAULT_LOCALE } from "./protocol.js";
export { LCODE_VERSION, LCODE_COMMIT, LCODE_BUILD_TIME } from "./version.js";
export type { HelloMessage, HelloAckMessage } from "./handshake.js";
export type { ArmsRumEnv, LCodeEnv, LCodeProductFlavor } from "./env.js";
export type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
export type {
  RemoteResourcePackageId,
  RemoteResourcePackageSelection,
} from "./remoteResourcePackages.js";
export type {
  DockerConnectOptions,
  RemoteTarget,
  SSHConnectOptions,
  WSLConnectOptions,
} from "./remoteTarget.js";
export { stripRemoteTargetSecrets } from "./remoteTarget.js";
export { buildSshRemoteHostKey } from "./remoteSshHostKey.js";
export { buildRemoteEnvironmentKey } from "./remoteEnvironmentKey.js";
export type {
  ShortcutChannel,
  ShortcutCommandEntry,
  ShortcutCommandId,
  ParsedShortcutBinding,
} from "./shortcutCommands.js";
export {
  SHORTCUT_COMMANDS,
  getDefaultShortcutBindings,
  isValidShortcutBinding,
  normalizeShortcutKey,
  parseShortcutBinding,
  serializeShortcutBinding,
} from "./shortcutCommands.js";
export {
  LCODE_ENV,
  LCODE_PRODUCT_FLAVOR,
  LCODE_APP_VERSION_ENV,
  LCODE_BUILD_COMMIT_ID_ENV,
  RUNTIME_LCODE_DEBUG,
  LCODE_TELEMETRY_REPORT_ENDPOINT,
  LCODE_ARMS_RUM_ENDPOINT,
  LCODE_TELEMETRY_ENABLED,
  mapLCodeEnvToArmsRumEnv,
  normalizeLCodeEnv,
  normalizeLCodeProductFlavor,
} from "./env.js";
export * from "./errors.js";
export type { SessionCreateSource } from "./sessionCreateSource.js";
export { resolveSafeEndpointHostname } from "./endpointHostname.js";
export * from "./rendererActionTrace.js";
export * from "./validation.js";
export * from "./api.js";
export * from "./lcode-protocol/index.js";
export * from "./account-provider-state.js";
// re-home：旧协议承重面的幸存文件（消费者继续走 barrel，零感知）
export * from "./lcode-protocol-legacy-types.js";
export * from "./lcode-task-types-core.js";
export * from "./task-realtime-core.js";
export * from "./remote-workspace-identity.js";
export * from "./lcode-api-retry-status.js";
export * from "./lcode-network-debug-status.js";
export * from "./lcode-session-visible-content.js";
export * from "./official-mcp-auth.js";
export * from "./official-mcp-tool-error.js";
export * from "./conversation-message-projection-policy.js";
export * from "./conversation-share.js";
export * from "./conversation-preview-artifacts.js";
export * from "./lcode-session-task-status.js";
export * from "./lcode-tool-projection-memory.js";
export * from "./lcode-slash-command-help.js";
export * from "./lcodeEndpoint.js";
export * from "./lcode-source-headers.js";
export * from "./lcode-agent-policy.js";
export * from "./lcode-media-policy.js";
export * from "./media-preview.js";
export * from "./plugin-display-name.js";
export * from "./lcode-agent-runtime.js";
export * from "./runtimeEnv.js";
export * from "./dynamic-workflow-feature.js";
export * from "./markdown-artifact-images.js";
export * from "./serviceAuthority.js";
export * from "./server-remote.js";

export interface ICredentialStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export * from "./test-ids.js";
export * from "./test-ids-workflow.js";
export * from "./channels.js";
export * from "./storage.js";
export * from "./oauth.js";
export * from "./desktopMenu.js";
export * from "./feedback.js";
export * from "./e2e-test-bridge.js";
export * from "./remoteAppConfig.js";
export * from "./remoteControl.js";
export * from "./remoteControlBridgeFrame.js";
export * from "./helpAppConfig.js";
export * from "./remoteAssetInstallMode.js";
export * from "./onboardingRecord.js";
export * from "./remoteResourcePackages.js";
export * from "./plan-identity.js";
export {
  BROWSER_SCREENSHOT_SURFACE_PREPARE_TIMEOUT_MS,
  BROWSER_VIEW_RESTORE_BOOTSTRAP_URL,
  LOCAL_MEDIA_PREVIEW_SCHEME,
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  createOpenInEditorRemoteTarget,
} from "./platform.js";
// Main 浏览器表面与窗口握手使用同一平台契约，公开类型不能只在实现文件内可见。
export type { BrowserViewSurfaceScaleMode, WindowControlsOverlayReadyPayload } from "./platform.js";
export type {
  ArmsCustomEventPayload,
  ConfigureFinalArmsCustomEventE2ERequest,
  FinalArmsCustomEventE2EEntry,
  FinalArmsCustomEventPayload,
  RendererTelemetryEventPayload,
  TelemetryEventPayload,
  TelemetryRendererContext,
} from "./telemetry.js";
export {
  collectTelemetryRendererContext,
  resolveSafeTelemetryHostname,
  sanitizeTelemetryErrorMessage,
  sanitizeTelemetryEventDetail,
} from "./telemetry.js";
export type {
  RedactTelemetryTextOptions,
  TelemetryProviderIdentity,
  TelemetryProviderScope,
} from "./telemetryRedaction.js";
export {
  TELEMETRY_SAFE_BUILTIN_MODEL_IDS,
  TELEMETRY_TEXT_MAX_LENGTH,
  redactTelemetryText,
  redactTelemetryUrl,
  resolveTelemetryModelId,
  resolveTelemetryProviderScope,
  sanitizeTelemetryModelValue,
} from "./telemetryRedaction.js";
export * from "./remoteUsageTelemetry.js";
export * from "./sessionCreateTelemetry.js";
export type { LaunchMarks } from "./launchMarks.js";
export { LAUNCH_MARKS_QUERY_KEY, parseLaunchMarks, serializeLaunchMarks } from "./launchMarks.js";
export type {
  CancelPendingRemoteConnectionRequest,
  BindRemoteWorkspaceSessionContextRequest,
  BrowserTabResidencyState,
  BrowserViewCloseTabNotification,
  BrowserViewCloseTabRequest,
  BrowserViewOperationPayload,
  BrowserViewResidencyReportPayload,
  BrowserViewResidencyTransitionPayload,
  BrowserViewRestoredTabShell,
  BrowserViewRestoreTabsRequest,
  BrowserViewScreenshotSurfacePreparePayload,
  BrowserViewScreenshotSurfaceReadyPayload,
  BrowserViewScreenshotSurfaceReleasePayload,
  BrowserViewViewportChangedPayload,
  ChromeBrowserDataImportError,
  ChromeBrowserDataImportOptions,
  ChromeBrowserDataImportResult,
  ConnectRemoteRequest,
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
  SaveFileRequest,
  SaveFileResult,
  PrintPageToPdfResult,
  DesktopCommandId,
  CuaOsSupport,
  DesktopWindowChromeState,
  DesktopTitleBarTheme,
  DockerContainerInfo,
  EditorInfo,
  ApplicationIconInfo,
  ApplicationIconLocator,
  ApplicationIconRequest,
  BrowserGuestAttachRejectReason,
  BrowserGuestAttachResult,
  EmbeddedBrowserDataClearResult,
  EmbeddedBrowserOpenUrlRequest,
  IPlatformService,
  OpenInEditorRemoteTarget,
  OpenInEditorOptions,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  RemoteServiceSession,
  SSHConfigAliasOption,
  TaskNotificationPayload,
  UpdateCheckResultPayload,
  UpdateStatePayload,
  WSLDistro,
  LCodeStdioTapDevState,
} from "./platform.js";
export type {
  CuaAccessibilitySettingsResult,
  CuaPermissionKind,
  OpenCuaPermissionOnboardingOptions,
  PrepareCuaHelperPermissionDragResult,
} from "./cuaAccessibilitySettings.js";
export type { LCodeTaskCreateResult } from "./lcode-task-types.js";
export * from "./lcode-task-types.js";
export * from "./automation-types.js";
export * from "./off-peak-types.js";
export * from "./background-task-control-merge.js";
export * from "./background-task-controls.js";
export * from "./background-task-notifications.js";
export * from "./background-bash-jobs.js";
export * from "./lcode-agent-model-state.js";
export * from "./task-realtime.js";
export { formatTimestamp, formatLogPrefix } from "./log-format.js";
export * from "./model-provider-types.js";
export * from "./model-provider-family.js";
export * from "./provider-family-connection-selection.js";
export * from "./provider-provisioning.js";
export * from "./custom-model-value.js";
export * from "./model-selection-types.js";
export * from "./model-selection-key.js";
export * from "./model-selection.js";
export * from "./legacy-model-provider-identity.js";
export * from "./official-glm-model-id.js";
export * from "./skills-types.js";
export * from "./skill-sync.js";
export * from "./mcp-sync.js";
export * from "./plugin-sync.js";
export * from "./remote-sync.js";
export * from "./plugin-types.js";
export * from "./subagents-types.js";
export * from "./settings-source.js";
export * from "./settings-errors.js";
export * from "./app-runtime-preferences.js";
export * from "./command-types.js";
export * from "./plugin-marketplaces.js";
export * from "./lineChangeStat.js";
export * from "./process-names.js";
export * from "./mcp.js";
export * from "./runtime-tool-runtime.js";
export * from "./git.js";
export * from "./gitPublish.js";
export * from "./gitCommitReview.js";
export * from "./gitReviewWorkspace.js";
export * from "./assistant-message-parts.js";
export * from "./lcodePersistedMessageMerge.js";
export * from "./assistant-presentation.js";
export * from "./tool-call-summary.js";
export * from "./tool-identity.js";
export * from "./streaming-tool-input-preview.js";
export * from "./tool-plan-adapter.js";
export * from "./permission-request-preview.js";
export * from "./settings-sync.js";
export * from "./uuid.js";
export * from "./usage-stats.js";
export * from "./coding-plan-subscription.js";
export * from "./forceUpdate.js";
export * from "./intranetProbe.js";
export * from "./intranetDefaults.js";
export * from "./hooks.js";
export * from "./openrouter-attribution.js";
export * from "./workspaceSessionRestore.js";
export * from "./skill-scan-policy.js";
export * from "./browser-use/index.js";

export * from "./coding-plan-reset.js";
export {
  parseSubagentMarkdownSelection,
  formatSubagentMarkdownModel,
} from "./subagent-markdown-selection.js";
export * from "./memoryDiagnostics.js";
export * from "./database-startup.js";
export * from "./processResourceTelemetry.js";
export * from "./execution-state.js";

export { bashOutputDisplaySchema } from "./bash-output-display.js";

export * from "./localTtft.js";
export * from "./pluginStoreOrder.js";
export * from "./clientConfig.js";
export * from "./pluginStoreOrdering.js";
export * from "./session-debug.js";
export { redactFeedbackText } from "./feedbackPrivacy.js";

export type { GitDeleteBranchRequest, GitDeleteBranchResult } from "./git.js";
export { gitDeleteBranchRequestSchema } from "./gitPublish.js";
