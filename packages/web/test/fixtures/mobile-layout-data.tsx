import type { IServiceAccessor, ModelSelectionView, ProviderSettingsView } from "@lcode/services";
import type { AppSettings, GitRepositorySummary } from "@lcode/shared";
import {
  conversationSnapshotSchema,
  type UserInputRow,
  type AssistantTextRow,
  type HookInvocationRow,
} from "@lcode/shared/lcode-protocol-v4";
import { SessionDataLayer } from "@/v4/sessionDataLayer.js";
import type { ConversationTransport } from "@/v4/transport.js";
import type { V4ConversationContextValue } from "@/v4/V4ConversationContext.js";
import { platform as basePlatform } from "./git-backup-platform.js";

export const workspacePath = "/mobile-layout-fixture";
export const noop = () => {};
const event = () => ({ dispose: noop });
export const counters = {
  terminalCreate: 0,
  terminalDispose: 0,
  settingsUpdate: 0,
  sends: 0,
  stops: 0,
  push: 0,
  actions: 0,
};
let revision = 0;
const listeners = new Set<() => void>();
export function changed() {
  revision++;
  for (const listener of listeners) listener();
}
export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const snapshotRevision = () => revision;
export function action() {
  counters.actions++;
  changed();
}
export const platform = { ...basePlatform, getDeviceId: () => "mobile-layout-fixture" };
const providerId = "fixture-provider";
export const modelId = "fixture-model-with-a-deliberately-long-readable-name";
export const selection = {
  providerId,
  modelId,
  options: { reasoningLevel: "high", speed: "fast" },
};
export const providerSettings: ProviderSettingsView = {
  revision: 1,
  providers: [],
  providerTemplates: [],
  providerOrder: [],
};
export const modelView: ModelSelectionView = {
  revision: 1,
  providers: [
    {
      providerId,
      providerName: "A deliberately long fixture provider",
      config: {
        api: { type: "openai-chat-completions", baseUrl: "https://fixture.invalid" },
        access: { type: "api-key" },
      },
      models: [
        {
          modelId,
          config: {
            enabled: true,
            properties: {
              requiresMfjsToolSchema: false,
              contextWindow: 128000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsAudio: false,
                supportsVideo: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: true,
              supportsJsonSchemaOutput: true,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: true,
            },
            optionSpecs: {
              reasoningLevel: { values: ["low", "medium", "high"], map: "{}" },
              maxOutputTokens: { max: 4096, map: "{}" },
              speed: { values: ["standard", "fast"], map: "{}" },
            },
          },
        },
      ],
    },
  ],
};
export const userRow: UserInputRow = {
  kind: "userInput",
  rowId: 1,
  entityId: "fixture-user",
  turnId: "fixture-turn",
  createdAt: 1,
  createdAtSeq: 1,
  origin: "realUser",
  text: "手机消息 / User message",
  actions: { canEdit: true },
};
export const assistantRow: AssistantTextRow = {
  kind: "assistantText",
  rowId: 2,
  entityId: "fixture-assistant",
  turnId: "fixture-turn",
  createdAt: 2,
  createdAtSeq: 2,
  state: "complete",
  text: "手机和桌面保留相同动作。Complete response with copy and fork actions.",
  actions: { canFork: true, canRetry: true },
};
export const hookRow: HookInvocationRow = {
  kind: "hookInvocation",
  rowId: 4,
  entityId: "fixture-hook",
  turnId: "fixture-hook-turn",
  createdAt: 4,
  createdAtSeq: 4,
  hookInvocationId: "fixture-hook-4",
  hookEventName: "Stop",
  hookCount: 1,
  state: "completed",
  startedAt: 4,
  lane: "assistantWork",
  executions: [
    {
      hookRunId: "fixture-hook-run",
      hookIndex: 0,
      didExecute: true,
      state: "completed",
      outcome: "success",
      startedAt: 4,
      displayName: "Fixture hook",
      sourceKind: "project",
    },
  ],
};
export const conversation = conversationSnapshotSchema.parse({
  protocolVersion: 1,
  sessionId: "mobile-fixture-session",
  logEpoch: "fixture-epoch",
  seq: 4,
  revision: 1,
  control: {
    phase: "completedSuccess",
    sessionEnded: true,
    canStop: false,
    stopState: "idle",
    stopTargetKind: "unknown",
    activeWorks: [],
    lastError: null,
    apiRetry: null,
  },
  availability: Object.fromEntries(
    [
      "fork",
      "compact",
      "switchModelConfig",
      "setFollowupMode",
      "queueEdit",
      "sendQueuedNow",
      "pauseGoal",
      "resumeGoal",
    ].map((key) => [key, { allowed: true }]),
  ),
  inputRouting: { mode: "startNow" },
  config: {
    modelSelection: selection,
    provider: providerId,
    model: modelId,
    thought: "high",
    thoughtLevels: ["low", "medium", "high"],
    followupMode: "queue",
    mode: "build",
    planEnabled: true,
  },
  usage: {
    contextWindow: {
      usedTokens: 84000,
      maxTokens: 128000,
      autoCompactThresholdTokens: 110000,
      breakdown: [
        { source: "messages", chars: 50000 },
        { source: "system_prompt", chars: 12000 },
        { source: "meta_user_context", chars: 8000 },
        { source: "skills", chars: 7000 },
        { source: "tool_prompt", chars: 6000 },
        { source: "system_tool_schemas", chars: 3000 },
        { source: "mcp_tool_schemas", chars: 2000 },
      ],
    },
    cumulative: {
      inputTokens: 420000,
      outputTokens: 50000,
      cacheReadTokens: 90000,
      cacheWriteTokens: 5000,
    },
  },
  queue: { items: [], autoDrain: true },
  pendingInteractions: [],
  pendingCommands: [],
  backgroundWorks: [],
  goal: null,
  plan: null,
  rows: { window: [userRow, assistantRow], totalCount: 2, firstRowId: 1 },
});
export const gitSummary: GitRepositorySummary = {
  workspacePath,
  repoRoot: workspacePath,
  workspaceInRepoPath: "",
  autoRefreshWatchPaths: [],
  branchName: "feature/long-fixture-branch-for-mobile-layout-and-keyboard-reachability",
  headRefType: "branch",
  trackingBranchName: null,
  ahead: 3,
  behind: 0,
  isDirty: false,
  isGitAvailable: true,
  isRepository: true,
};
const dataListeners = new Map<string, Set<(value: string) => void>>();
let settings: AppSettings = {
  recentProjects: [],
  localProjects: [],
  locale: "zh-CN",
  terminalFontFamily: "Fixture monospace",
  httpProxy: "",
  httpProxyNoProxy: "",
  httpProxyCaCertPath: "",
  memoryEnabled: false,
  sessionRecallEnabled: false,
};
// 严格、封闭的 fixture 服务集合：没有真实 HTTP/RPC/文件写入，未配置命令直接拒绝。
const reject = async () => {
  throw new Error("This operation is not part of the isolated layout fixture");
};
export const services = {
  settingService: {
    get: async () => settings,
    update: async (patch: Partial<AppSettings>) => {
      settings = { ...settings, ...patch };
      counters.settingsUpdate++;
      changed();
    },
    updateDataBaseDir: async (value: string) => {
      settings = { ...settings, dataBaseDir: value };
      counters.settingsUpdate++;
      changed();
    },
  },
  systemService: {
    info: async () => ({ homedir: "/fixture-home", platform: "linux" }),
    listIntegratedTerminalShells: async () => [],
  },
  broadcastService: {
    send: async () => {},
    onMessage: event,
    tryClaim: async () => true,
    acquireClaim: async () => ({ status: "unavailable" }),
    commitClaim: async () => {},
    releaseClaim: async () => {},
  },
  providerSettingsService: { getView: async () => providerSettings, onDidChange: event },
  lcodeAgentService: {
    syncAppRuntimePreferences: async () => {},
    onAgentRuntimeRestarted: event,
    onDynamicSessionsIndexFrame: () => event,
    helloConversationV4: reject,
    initializeConversationV4: reject,
    unsubscribeSessionsIndexV4: async () => {},
  },
  clientConfigService: { getSnapshot: async () => ({ pluginStoreOrder: { code: [], work: [] } }) },
  pluginManagementService: {
    getPluginReferenceCatalog: async () => ({ authority: "session", plugins: [] }),
  },
  lcodeSessionService: { closeSession: reject },
  lcodeTaskService: { queryWorkspaceTasks: async () => [], renameTask: reject },
  promptAttachmentTransferService: { onDynamicProgress: () => event },
  terminalService: {
    create: async () => {
      const id = `fixture-terminal-${++counters.terminalCreate}`;
      changed();
      return { id, shell: "fixture-shell", fontFamily: "monospace", fontFamilySource: "fallback" };
    },
    write: async ({ id, data }: { id: string; data: string }) => {
      for (const listener of dataListeners.get(id) ?? [])
        listener(data === "\r" ? "\r\nfixture> " : data);
    },
    resize: async () => {},
    dispose: async () => {
      counters.terminalDispose++;
      changed();
    },
    onDynamicData: (id: string) => (listener: (data: string) => void) => {
      const set = dataListeners.get(id) ?? new Set();
      dataListeners.set(id, set);
      set.add(listener);
      queueMicrotask(() => listener("Fixture terminal (no process)\r\nfixture> "));
      return { dispose: () => set.delete(listener) };
    },
    onDynamicExit: () => event,
  },
  fileService: { list: async () => [], searchWorkspaceFiles: async () => [], readFile: reject },
  fileWatcherService: { watch: async () => "fixture", unwatch: async () => {}, onDidChange: event },
  gitService: {
    refresh: async () => ({
      summary: gitSummary,
      identity: {
        userName: "Fixture",
        userEmail: "fixture@example.invalid",
        nameSource: "local",
        emailSource: "local",
      },
      unstagedChanges: [],
      stagedChanges: [],
      branchComparison: null,
    }),
    push: async () => {
      counters.push++;
      changed();
      throw new Error(
        Array.from(
          { length: 30 },
          (_, index) =>
            `fixture error line ${index + 1}: denied by deterministic mock; no network request`,
        ).join("\n"),
      );
    },
  },
} as unknown as IServiceAccessor;
const transport: ConversationTransport = {
  onFrame: () => noop,
  onAssemblyFault: () => noop,
  onRuntimeRestart: () => noop,
  subscribe: reject,
  activate: noop,
  resync: reject,
  unsubscribe: async () => {},
  sendCommand: reject,
  queryCommands: reject,
  rowsRange: reject,
  plans: reject,
  workflowRunEvents: reject,
  workflowRuns: reject,
  workflowRunArtifacts: reject,
  workflowRunArtifactData: reject,
  workflowRunArtifactRead: reject,
  workflowRunWorkspace: reject,
  workflowRunNodeResult: reject,
  fileChanges: reject,
  fileRewindPreview: reject,
  attachmentPut: reject,
  attachmentRead: reject,
  attachmentReadRange: reject,
};
export const layer = new SessionDataLayer({ transport });
const attachmentPut: V4ConversationContextValue["attachmentPut"] = async ({ fileName }) => ({
  ref: `fixture-attachment:${fileName}`,
});
export const conversationContext: V4ConversationContextValue = {
  layer,
  sendCommand: reject,
  fileChanges: reject,
  fileRewindPreview: reject,
  workflowRunEvents: reject,
  workflowRuns: reject,
  workflowRunArtifacts: reject,
  workflowRunArtifactData: reject,
  workflowRunArtifactRead: reject,
  workflowRunWorkspace: reject,
  workflowRunNodeResult: reject,
  attachmentPut,
  attachmentRead: reject,
  attachmentReadRange: reject,
  onRuntimeRestart: () => noop,
};
