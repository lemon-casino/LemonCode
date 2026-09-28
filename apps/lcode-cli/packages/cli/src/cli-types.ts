import type { TuiReadClipboardImage, TuiWriteClipboardText } from "@lcode/tui";
import type { UiLocale } from "@lcode/i18n";
import type { Logger } from "@lcode/contracts";
import type {
  createManagedCdpBrowserRuntime,
  ManagedCdpBrowserRuntimeOptions,
} from "@lcode/adapters/browser";
import type {
  createModelAdapter,
  createLCodeApp,
  CreateModelAdapterOptions,
  configureCodingPlanApiKey,
  ConfigureCodingPlanApiKeyOptions,
  inspectLCodeSkill,
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
  revokeWorkspaceHookTrustCli,
  inspectLCodeCustomCommand,
  InspectLCodeCustomCommandOptions,
  InspectLCodeSkillOptions,
  loginLCodeCli,
  loginBigmodelCodingPlan,
  LoginBigmodelCodingPlanOptions,
  LoginLCodeCliOptions,
  listLCodeCustomCommands,
  ListLCodeCustomCommandsOptions,
  loadLCodeCustomCommand,
  listLCodeSessions,
  listLCodeSkills,
  ListLCodeSessionsOptions,
  ListLCodeSkillsOptions,
  logoutLCodeCli,
  LogoutLCodeCliOptions,
  resolveLatestSession,
  ResolveLatestSessionOptions,
  RunLCodeProtocolAgentOptions,
  prepareLCodeTelemetryEnv,
  startProcessProviderRegistryRuntime,
  shutdownLCodeTelemetry,
  LCodeAppOptions,
} from "@lcode/bootstrap";
import type { CliEnv, DotenvLoadResult, LoadCliDotenvOptions } from "./env.js";
import type { PluginsCommandOverrides } from "./plugins-command.js";
import type { CliShutdownProcess } from "./shutdown.js";
import type { resolveWorkspaceGitBranch } from "./tui-workspace-git.js";

export type BootstrapModule = typeof import("@lcode/bootstrap");

export interface RunDependencies extends PluginsCommandOverrides {
  protocolLifecycle?: RunLCodeProtocolAgentOptions["lifecycle"];
  protocolInput?: NodeJS.ReadableStream;
  createManagedCdpBrowserRuntime?: (
    options?: ManagedCdpBrowserRuntimeOptions,
  ) => ReturnType<typeof createManagedCdpBrowserRuntime>;
  createModelAdapter?: (
    options?: CreateModelAdapterOptions,
  ) => ReturnType<typeof createModelAdapter>;
  createLCodeApp?: (
    options?: LCodeAppOptions,
  ) => Awaited<ReturnType<typeof createLCodeApp>> | ReturnType<typeof createLCodeApp>;
  /**
   * Session-event shaper for --output-format stream-json. Defaults to the
   * bootstrap module's, which is also what the protocol server uses; injectable
   * so a caller that supplies its own `createLCodeApp` (tests, embedders) can
   * still stream, since the bootstrap module is not loaded on that path.
   */
  mapSessionEvent?: BootstrapModule["mapSessionEvent"];
  cwd?: () => string;
  env?: CliEnv;
  inspectSkill?: (options: InspectLCodeSkillOptions) => ReturnType<typeof inspectLCodeSkill>;
  inspectWorkspaceHookTrust?: typeof inspectWorkspaceHookTrust;
  grantWorkspaceHookTrust?: typeof grantWorkspaceHookTrust;
  revokeWorkspaceHookTrustCli?: typeof revokeWorkspaceHookTrustCli;
  inspectCustomCommand?: (
    options: InspectLCodeCustomCommandOptions,
  ) => ReturnType<typeof inspectLCodeCustomCommand>;
  loginLCodeCli?: (options?: LoginLCodeCliOptions) => ReturnType<typeof loginLCodeCli>;
  loginBigmodelCodingPlan?: (
    options?: LoginBigmodelCodingPlanOptions,
  ) => ReturnType<typeof loginBigmodelCodingPlan>;
  configureCodingPlanApiKey?: (
    options: ConfigureCodingPlanApiKeyOptions,
  ) => ReturnType<typeof configureCodingPlanApiKey>;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
  prepareLCodeTelemetryEnv?: typeof prepareLCodeTelemetryEnv;
  projectConfigPath?: string;
  listSessions?: (options: ListLCodeSessionsOptions) => ReturnType<typeof listLCodeSessions>;
  listCustomCommands?: (
    options: ListLCodeCustomCommandsOptions,
  ) => ReturnType<typeof listLCodeCustomCommands>;
  loadCustomCommand?: (
    options: InspectLCodeCustomCommandOptions,
  ) => ReturnType<typeof loadLCodeCustomCommand>;
  // headless slash 路由要和 app facade 的保留名 gate 用同一个判据；默认取 bootstrap 的，
  // 注入点只为让单测不必拉起整个 bootstrap 模块。见 prompt-command.ts。
  isReservedSlashCommandName?: BootstrapModule["isReservedLCodeSlashCommandName"];
  listSkills?: (options: ListLCodeSkillsOptions) => ReturnType<typeof listLCodeSkills>;
  logger?: Logger;
  readClipboardImage?: TuiReadClipboardImage;
  writeClipboardText?: TuiWriteClipboardText;
  resolveLatestSession?: (
    options: ResolveLatestSessionOptions,
  ) => ReturnType<typeof resolveLatestSession>;
  resolveWorkspaceGitBranch?: typeof resolveWorkspaceGitBranch;
  logoutLCodeCli?: (options?: LogoutLCodeCliOptions) => ReturnType<typeof logoutLCodeCli>;
  runLCodeProtocolAgent?: (options?: RunLCodeProtocolAgentOptions) => Promise<void>;
  runTui?: typeof import("@lcode/tui").runTui;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  exitProcess?: (code: number) => void;
  shutdownCleanupTimeoutMs?: number;
  shutdownProcess?: CliShutdownProcess;
  startProcessProviderRegistryRuntime?: typeof startProcessProviderRegistryRuntime;
  shutdownLCodeTelemetry?: typeof shutdownLCodeTelemetry;
}

export type CliPermissionMode = "build" | "plan" | "edit" | "yolo";
export type CliRuntimeMode = CliPermissionMode | "auto";

export interface CliModeState {
  current?: CliRuntimeMode;
  override?: CliPermissionMode;
}

export interface CliTargetRequest {
  objective: string;
  replaceExisting: boolean;
}

export type ModeCapableApp = Awaited<ReturnType<typeof createLCodeApp>> & {
  getMode?: () => CliRuntimeMode;
  setLocale?: (locale: UiLocale) => Promise<{ locale: "en-US" | "zh-CN" }>;
  setMode?: (mode: CliRuntimeMode) => Promise<{ mode: CliRuntimeMode }>;
};

export interface CliResumeRequest {
  continueSession: boolean;
  resumeSessionId?: string;
}
