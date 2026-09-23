import type { CuaPermissionRestartOptions, CuaPermissionRestartResult } from "./broker.d.ts";

export {
  HELPER_ADDON_ENV,
  HELPER_CONTROL_PROTOCOL,
  WINDOWS_DEV_CONTROL_PROTOCOL,
} from "./broker-helper-constants.js";

export interface HelperProcessLaunchSpec {
  socketPath: string;
  pipSocketPath?: string;
  launcherPid?: number;
  exitLogPath?: string;
  pipMode?: "enabled" | "disabled";
  permissionRequest?: "accessibility" | "screen_recording";
  permissionPreflight?: "screen_recording";
  waitForExit?: boolean;
  [key: string]: unknown;
}

export interface HelperLaunchSpec extends HelperProcessLaunchSpec {
  appPath: string;
}

export declare function buildHelperProcessArgs(
  spec: HelperProcessLaunchSpec,
  launcherPid?: number,
): string[];
export declare function buildHelperOpenArgs(spec: HelperLaunchSpec, launcherPid?: number): string[];

export declare function isCuaLocalDevelopmentRuntime(
  env?: NodeJS.ProcessEnv,
  compiledLocalDevelopmentRuntime?: boolean,
): boolean;

export interface HelperPermissionSubjectIdentity {
  appPath: string;
  executablePath: string;
  displayName: string;
  bundleId: string;
  [key: string]: unknown;
}

export declare function resolveHelperPermissionSubjectIdentity(
  appPath: string,
  options?: {
    platform?: string;
    readPlistValue?: (infoPlistPath: string, key: string) => Promise<string>;
    realpath?: (path: string) => Promise<string>;
    stat?: (path: string) => Promise<{ isDirectory(): boolean; isFile(): boolean }>;
    dependencies?: Record<string, unknown>;
  },
): Promise<HelperPermissionSubjectIdentity>;

export interface CuaHelperVerifierDependencies {
  readExecutableArchs: (executablePath: string) => Promise<string[]>;
  verifyCodeSignature: (appPath: string) => Promise<void>;
  verifyTeamIdentifier: (
    appPath: string,
    expectedTeamIdentifier?: string,
  ) => Promise<string | void>;
  verifyGatekeeper?: (appPath: string) => Promise<void>;
  resolveIdentity: typeof resolveHelperPermissionSubjectIdentity;
  copyBundle: (source: string, destination: string) => Promise<void>;
  [key: string]: unknown;
}

export interface CuaHelperInstallerOptions {
  env?: NodeJS.ProcessEnv;
  logger?: unknown;
  bundledAppPath?: string;
  installRoot?: string;
  installPath?: string;
  platform?: string;
  arch?: string;
  expectedTeamIdentifier?: string;
  compiledLocalDevelopmentRuntime?: boolean;
  plan?: {
    installRoot?: string;
    installPath?: string;
    bundledAppPath?: string;
    [key: string]: unknown;
  };
  dependencies?: Partial<CuaHelperVerifierDependencies>;
}

export interface CuaHelperInstaller {
  ensureInstalled(): Promise<string>;
  verifyInstalled(appPath: string, options?: unknown): Promise<void>;
}

export declare function createCuaHelperInstaller(
  options?: CuaHelperInstallerOptions,
): CuaHelperInstaller;

export declare const defaultCuaHelperVerifierDependencies: CuaHelperVerifierDependencies;

export declare function cuaBrokerRefreshMarkerPath(socketPath: string): string | undefined;
export interface CuaBrokerRefreshMarkerHandle {
  path: string | undefined;
  dispose(): Promise<void>;
}
export declare function publishCuaBrokerRefreshMarker(
  socketPath: string,
  options?: { deadlineMs?: number; now?: () => number },
): Promise<CuaBrokerRefreshMarkerHandle>;

export interface HelperNativeAddon {
  [key: string]: unknown;
}

export interface HelperNativeAddonOptions {
  env?: NodeJS.ProcessEnv;
  modulePath?: string;
  resourcesPath?: string;
  relativePath?: string;
  rootPath?: string;
  require?: (path: string) => HelperNativeAddon;
}

export declare function loadRealNativeAddon(options?: HelperNativeAddonOptions): HelperNativeAddon;
export declare function resolvePackagedNativeAddonPath(
  options?: HelperNativeAddonOptions,
): string | undefined;
export declare function resolveInTreeAddonPath(
  options?: HelperNativeAddonOptions,
): string | undefined;

export interface AxReadOnlySource {
  [key: string]: unknown;
}

export declare function createAxReadOnlyMethods(
  source: AxReadOnlySource,
  registry?: unknown,
  options?: unknown,
): Record<string, unknown>;
export declare const ROLE_TO_KIND: Readonly<Record<string, string>>;
export declare function roleToKind(role: string): string | undefined;

export declare class CuaHelperLifecycleManager<Managed> {
  constructor(dispose?: (managed: Managed) => Promise<void> | void);
  acquire(options: {
    isAdmitted?: () => boolean;
    shouldRetainCurrent?: (current: Managed) => boolean;
    create: () => Managed | undefined | Promise<Managed | undefined>;
  }): Promise<Managed | undefined>;
  peek(): Managed | undefined;
  readonly disposed: boolean;
  dispose(managed?: Managed): Promise<void>;
}

export interface CuaProductMcpServerResolverContext {
  workspacePath?: string;
  workspaceIdentity?: string;
  [key: string]: unknown;
}

export interface CuaHelperTransportHandle {
  socketPath: string;
  pipSocketPath?: string;
  pluginAuthority: string;
  generation?: number;
  [key: string]: unknown;
}

export interface CuaPermissionStatusQueryReport {
  grant_owner: string | null;
  owner?: { display_name?: string | null } | null;
  accessibility: "granted" | "stale" | "denied" | "unknown";
  accessibility_probe?: { ok: boolean; classification?: string };
  screen_recording: "granted" | "denied" | "unknown";
  screen_capture_probe?: { ok: boolean; classification?: string };
  [key: string]: unknown;
}

export interface CuaProductHelperHost {
  readonly running: boolean;
  readonly socketPath: string | null;
  readonly pipSocketPath?: string | null;
  readonly pluginAuthority: string | null;
  readonly generation?: number;
  readonly reservedTransport?: CuaHelperTransportHandle;
  start(): Promise<CuaHelperHandle>;
  stop(): Promise<void>;
  restart(): Promise<CuaHelperHandle>;
  restartAfterCurrentStart(): Promise<CuaHelperHandle>;
  restartAfterCurrentStartPreservingTransport?(
    restartOptions?: CuaHelperTransportRestartOptions,
  ): Promise<CuaHelperTransportRestartResult>;
  waitForTransport?(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
  checkHealth(timeoutMs?: number): Promise<import("./broker.d.ts").HelperHealth>;
}

export type ManagedCuaProductHelperHost = CuaProductHelperHost;

export interface CuaHelperHost extends CuaProductHelperHost {
  readonly reservedTransport: CuaHelperTransportHandle | undefined;
  waitForTransport(timeoutMs?: number): Promise<CuaHelperTransportHandle>;
  queryScreenCaptureProbe(): Promise<{ ok: boolean; reason?: string }>;
  queryScreenRecordingPreflight(): Promise<"granted" | "denied" | "unknown" | undefined>;
  queryPermissionStatus(): Promise<CuaPermissionStatusQueryReport>;
}

export interface CuaHelperTransportRestartOptions {
  beforeFreshStart?: () => void | Promise<void>;
  [key: string]: unknown;
}

export interface CuaHelperTransportRestartResult {
  handle: CuaHelperHandle;
  reused: boolean;
}

export interface CuaHelperHandle {
  socketPath: string;
  pipSocketPath?: string;
  launchSocketPath?: string;
  pluginAuthority: string;
  generation?: number;
  helperAppPath?: string;
  bundleId?: string | null;
  pid?: number | null;
  [key: string]: unknown;
}

export interface CuaProductMcpServerConfigLike {
  [key: string]: unknown;
}

export interface CuaProductMcpServerResolver {
  resolveMcpServers<T>(
    servers: T[] | undefined,
    context?: CuaProductMcpServerResolverContext,
  ): Promise<T[] | undefined>;
  restart(): Promise<void>;
  restartAfterPermissionGrant(onboardingSessionId?: string): Promise<void>;
}

export declare class CuaProductHelperWorkspaceRegistry {
  setEnabled(context: CuaProductMcpServerResolverContext | undefined, enabled: boolean): void;
  isEnabled(context: CuaProductMcpServerResolverContext | undefined): boolean;
  delete(context: CuaProductMcpServerResolverContext | undefined): boolean;
  clear(): void;
  readonly size: number;
}

export interface CreateProductCuaHelperHostOptions {
  logger?: unknown;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  helperInstaller?: CuaHelperInstaller;
  bundledHelperAppPath?: string;
  healthTimeoutMs?: number;
  permissionTimeoutMs?: number;
  socketPath?: string;
  pipSocketPath?: string;
  socketDirectory?: string;
  pluginAuthority?: string;
  generation?: number;
  launcherPid?: number;
  pipMode?: string;
  compiledLocalDevelopmentRuntime?: boolean;
  randomBytes?: (size: number) => Buffer;
  launchApplication?: (options: {
    appPath: string;
    args: string[];
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
    credential: { capability: string; generation: number };
  }) => Promise<{
    bundleId: string;
    pid: number;
    exited?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    releaseControl?: () => void;
    terminate?: () => void | Promise<void>;
  }>;
  healthProbe?: typeof import("./broker.d.ts").probeHelperHealth;
  callBrokerMethod?: typeof import("./broker.d.ts").callBrokerMethod;
  queryScreenRecordingPreflight?: (options: {
    helperAppPath: string;
    env: NodeJS.ProcessEnv;
  }) => Promise<"granted" | "denied" | "unknown" | undefined>;
  [key: string]: unknown;
}

export declare function createProductCuaHelperHost(
  options?: CreateProductCuaHelperHostOptions,
): CuaHelperHost;

export declare function createCuaProductMcpServerResolver(
  host: CuaProductHelperHost,
  options?: {
    hasActiveTurn?: () => boolean;
    healthTimeoutMs?: number;
    publishRefreshMarker?: (socketPath: string | null) => void | Promise<void>;
    onDiagnostic?: (code: string, error: unknown) => void;
  },
): CuaProductMcpServerResolver;

export interface IsOfficialCuaPluginEnabledForWorkspaceOptions {
  env?: NodeJS.ProcessEnv;
  workingDirectory?: string;
  userConfig?: Record<string, unknown>;
  workspaceConfig?: Record<string, unknown>;
  userConfigPath?: string;
  workspaceConfigPath?: string;
  [key: string]: unknown;
}

export declare function isOfficialCuaPluginEnabledForWorkspace(
  options?: IsOfficialCuaPluginEnabledForWorkspaceOptions,
): boolean;

export declare function waitForCuaHelperStartup<T>(
  startup: Promise<T>,
  deadlineMs?: number,
): Promise<T>;

export declare function isPotentialZCodeCuaAgentMcpServer(server: unknown): boolean;

export interface CuaScreenCaptureProbeResult {
  ok: boolean;
  reason?: string;
}

export declare function isScreenCaptureProbeSuccess(
  probe: CuaScreenCaptureProbeResult | undefined,
): boolean;

export declare function markCuaProductHelperAgentEnvUnavailable(
  host: Pick<CuaHelperHost, "start">,
): void;
export declare function hasCuaProductHelperAgentEnvUnavailable(
  host: Pick<CuaHelperHost, "start">,
): boolean;
export declare function clearCuaProductHelperAgentEnvUnavailable(
  host: Pick<CuaHelperHost, "start">,
): void;

export declare function reapOrphanedHelpers(options: {
  logger?: unknown;
  env?: NodeJS.ProcessEnv;
  platform?: string;
  dependencies?: {
    listProcesses?: () => Promise<Array<{ pid: number; command: string }>>;
    isProcessAlive?: (pid: number) => boolean;
    terminate?: (pid: number) => void | Promise<void>;
  };
}): Promise<void>;

export interface HelperPermissionRequestResult {
  ok: boolean;
  reason?: string;
}

export interface HelperPermissionRequestOptions {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  helperAppPath?: string;
  ensureInstalled?: () => Promise<string>;
  socketPath?: string;
  socketDirectory?: string;
  exitLogPath?: string;
  launcherPid?: number;
  timeoutMs?: number;
  launchApplication?: (options: {
    appPath: string;
    args: string[];
    timeoutMs: number;
    env: NodeJS.ProcessEnv;
  }) => Promise<void>;
}

export declare function requestHelperAccessibilityPermissionViaLaunchServices(
  options?: HelperPermissionRequestOptions,
): Promise<HelperPermissionRequestResult>;

export declare function requestHelperScreenRecordingPermissionViaLaunchServices(
  options?: HelperPermissionRequestOptions,
): Promise<HelperPermissionRequestResult>;

export declare function queryHelperScreenRecordingPreflightViaLaunchServices(
  options?: HelperPermissionRequestOptions,
): Promise<"granted" | "denied" | undefined>;

export type { CuaPermissionRestartOptions, CuaPermissionRestartResult };
