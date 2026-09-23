export type Xa11yProducerMethod =
  | "list_apps"
  | "list_windows"
  | "get_app_state"
  | "left_click"
  | "left_click_drag"
  | "scroll"
  | "type"
  | "set_value"
  | "select_text"
  | "key"
  | "paste"
  | "perform_action"
  | "request_access"
  | "stop_computer_control";

export declare const XA11Y_PRODUCER_METHODS: readonly Xa11yProducerMethod[];

export type Xa11yProducerErrorCode =
  | "INVALID_REQUEST"
  | "PERMISSION_DENIED"
  | "APP_NOT_FOUND"
  | "APP_NOT_READY"
  | "LAUNCH_FAILED"
  | "AMBIGUOUS_APP"
  | "INVALID_APP"
  | "ELEMENT_UNAVAILABLE"
  | "STALE_STATE"
  | "NOT_SETTABLE"
  | "NOT_SELECTABLE"
  | "ACTION_UNAVAILABLE"
  | "FOREGROUND_REQUIRED"
  | "CONTROL_STOPPED"
  | "HELPER_UNAVAILABLE"
  | "TIMEOUT"
  | "STRUCTURED_STATE_UNAVAILABLE"
  | "INTERNAL";

export declare class Xa11yProducerError extends Error {
  constructor(
    code: Xa11yProducerErrorCode,
    message: string,
    options?: {
      actionSent?: boolean;
      retry?: "reobserve" | "retry" | "never";
      details?: unknown;
    },
  );
  readonly code: Xa11yProducerErrorCode;
  readonly actionSent: boolean;
  readonly retry: "reobserve" | "retry" | "never";
  readonly details?: unknown;
}

export interface Xa11yProducerContext {
  workspaceKey: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface Xa11yAppRef {
  name?: string;
  bundle_id?: string;
  pid?: number;
  window_id?: number;
}

export type Xa11yTarget =
  | number
  | readonly [number, number]
  | { type: "element"; index: number }
  | { type: "coordinate"; x: number; y: number; frame_id?: string };

export interface Xa11yAppInfo {
  pid: number | null;
  name: string | null;
  bundle_id: string | null;
  active: boolean;
}

export interface Xa11yWindowInfo {
  index: number;
  window_id: number | null;
  title: string | null;
  bounds: [number, number, number, number] | null;
  main: boolean | null;
  focused: boolean;
  onscreen: boolean;
  subrole?: string;
}

export interface Xa11yElementInfo {
  index: number;
  parent_index: number | null;
  depth: number;
  kind: string | null;
  role: string | null;
  title: string | null;
  name: string | null;
  value: string | null;
  description: string | null;
  stable_id: string | null;
  bounds: [number, number, number, number] | null;
  actions: string[];
  enabled: boolean;
  visible: boolean;
  focused: boolean;
  active: boolean;
  checked: "on" | "off" | "mixed" | null;
  selected: boolean;
  expanded: boolean | null;
  editable: boolean;
  focusable: boolean;
}

export interface Xa11yScreenshotData {
  data: string;
  mime_type: "image/png";
  width: number;
  height: number;
  frame_id: string;
}

export interface Xa11yAppState {
  state_id: string;
  mode: "full" | "incremental";
  base_state_id: string | null;
  app: Xa11yAppInfo;
  window: Xa11yWindowInfo;
  focused_element: number | null;
  elements: Xa11yElementInfo[];
  text: string;
  frame_id?: string;
  screenshot?: Xa11yScreenshotData;
  /** UIA/AX 子树读取降级时的诊断；存在时只能使用本次截图坐标，元素索引仍 fail closed。 */
  tree_unavailable_reason?: string;
  non_actionable_reason?: string;
  changes?: {
    added_count: number;
    removed_count: number;
    updated_count: number;
    added: Xa11yElementInfo[];
    removed: Array<{ index: number; stable_id: string | null }>;
    updated: Xa11yElementInfo[];
  };
}

export interface Xa11yModuleLike {
  App: { list(): Promise<unknown[]> };
  inputSim?: () => unknown;
  screenshot?: (options: { element: unknown }) => Promise<unknown>;
}

export interface Xa11yProducerOptions {
  /** 缺省时首次需要 xa11y 的 dispatch 才动态 import 原生包。 */
  loadXa11y?: () => Promise<Xa11yModuleLike>;
  /** 平台身份归一化；产品 Helper 传入自身平台，测试可注入。 */
  platform?: NodeJS.Platform;
  /** Helper 权限链 seam；xa11y 本身不负责查询/触发产品授权。 */
  requestAccess?: (input: {
    capabilities?: string[];
    context: Xa11yProducerContext;
  }) => Promise<unknown>;
  /** Helper clipboard seam；实现需借用并恢复用户剪贴板。 */
  paste?: (input: {
    text: string;
    format: "text" | "md" | "html";
    context: Xa11yProducerContext;
  }) => Promise<void>;
  /** Helper lease/queue stop seam；producer 自身始终先清当前 session snapshot。 */
  stop?: (input: { reason?: string; context: Xa11yProducerContext }) => Promise<void>;
  /** 已安装应用启动端口；仅首次 get_app_state 零匹配时调用。 */
  launcher?: {
    resolve?: (ref: Pick<Xa11yAppRef, "name" | "bundle_id">) => Promise<
      | {
          name?: string;
          bundleId?: string;
          appId?: string;
          desktopId?: string;
          executable?: string;
        }
      | undefined
    >;
    launch(ref: Pick<Xa11yAppRef, "name" | "bundle_id">): Promise<
      | {
          name?: string;
          bundleId?: string;
          appId?: string;
          desktopId?: string;
          executable?: string;
        }
      | undefined
    >;
    dispose?(): Promise<void>;
  };
  launchPollAttempts?: number;
  launchPollIntervalMs?: number;
  randomUUID?: () => string;
  delay?: (milliseconds: number) => Promise<void>;
  maxElements?: number;
  /** 坐标型原始输入的内部轨迹；默认 instant。 */
  motionProfile?: "instant" | "smooth";
  motionDurationMs?: number;
  motionSegmentPixels?: number;
  motionMaxSegments?: number;
}

export interface Xa11yProducer {
  dispatch(
    method: Xa11yProducerMethod,
    params: unknown,
    context: Xa11yProducerContext,
  ): Promise<unknown>;
  execute(input: {
    method: Xa11yProducerMethod;
    params?: unknown;
    context: Xa11yProducerContext;
  }): Promise<unknown>;
  closeSession(context: Xa11yProducerContext): Promise<void>;
  dispose(): Promise<void>;
}

export declare function createXa11yProducer(options?: Xa11yProducerOptions): Xa11yProducer;
