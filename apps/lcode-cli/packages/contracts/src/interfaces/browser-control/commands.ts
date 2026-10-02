import type { BrowserMouseButton, BrowserKeyModifier, BrowserPoint } from "./context.js";
import type { BrowserPlaywrightAction, BrowserRecordingOptions } from "./actions.js";

export type BrowserCommandMethod =
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "snapshot"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "cuaKeypress"
  | "scroll"
  | "cuaScroll"
  | "domCuaScroll"
  | "hover"
  | "select"
  | "check"
  | "drag"
  | "cuaDrag"
  | "screenshot"
  | "getState"
  | "elementInfo"
  | "evaluate"
  | "getDialog"
  | "handleDialog"
  | "waitFor"
  | "playwright"
  | "playwrightWaitForTimeout"
  | "capabilities"
  | "browserVisibilityGet"
  | "browserVisibilitySet"
  | "browserViewportSet"
  | "browserViewportReset"
  | "recordingStart"
  | "recordingStatus"
  | "recordingCancel"
  | "activateTab"
  | "newTab"
  | "finalize"
  | "finalizeTabs"
  | "listUserTabs"
  | "claimTab"
  | "markDeliverable"
  | "markHandoff"
  | "nameSession"
  | "turnEnded"
  | "closeSession"
  | "cancelRequest"
  | "close"
  | "list";

// tabId（可选）：agent 对象模型用于寻址指定受控 tab（含 human 开的 tab）；缺省作用于会话默认 view。
// 与 @lcode/shared 的 browserCommandSchema 各变体结构镜像同步。
export type BrowserCommand =
  | { method: "navigate"; url: string; tabId?: string }
  | { method: "back"; tabId?: string }
  | { method: "forward"; tabId?: string }
  | { method: "reload"; tabId?: string }
  | { method: "snapshot"; maxElements?: number; includeHidden?: boolean; tabId?: string }
  | {
      method: "click";
      ref?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "fill"; ref: string; value: string; tabId?: string }
  | { method: "type"; ref?: string; text: string; tabId?: string }
  | { method: "press"; key: string; ref?: string; modifiers?: BrowserKeyModifier[]; tabId?: string }
  | { method: "cuaKeypress"; keys: string[]; tabId?: string }
  | { method: "scroll"; ref?: string; x?: number; y?: number; tabId?: string }
  | {
      method: "cuaScroll";
      x: number;
      y: number;
      scrollX: number;
      scrollY: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "domCuaScroll"; nodeId?: string; scrollX: number; scrollY: number; tabId?: string }
  | {
      method: "hover";
      ref?: string;
      x?: number;
      y?: number;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | { method: "select"; ref: string; values: string[]; tabId?: string }
  | { method: "check"; ref: string; checked?: boolean; tabId?: string }
  | {
      method: "drag";
      fromRef?: string;
      toRef?: string;
      from?: BrowserPoint;
      to?: BrowserPoint;
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "cuaDrag";
      path: BrowserPoint[];
      modifiers?: BrowserKeyModifier[];
      tabId?: string;
    }
  | {
      method: "screenshot";
      ref?: string;
      fullPage?: boolean;
      clip?: { x: number; y: number; width: number; height: number };
      tabId?: string;
    }
  | { method: "getState"; tabId?: string }
  | { method: "elementInfo"; x: number; y: number; tabId?: string }
  | { method: "evaluate"; expression: string; tabId?: string }
  | { method: "getDialog"; tabId?: string }
  | { method: "handleDialog"; accept: boolean; promptText?: string; tabId?: string }
  | {
      method: "waitFor";
      selector?: string;
      text?: string;
      textGone?: string;
      timeoutMs?: number;
      tabId?: string;
    }
  | { method: "playwrightWaitForTimeout"; timeoutMs: number; tabId?: string }
  | { method: "playwright"; action: BrowserPlaywrightAction; tabId?: string }
  | { method: "capabilities"; tabId?: string }
  | { method: "browserVisibilityGet" }
  | { method: "browserVisibilitySet"; visible: boolean }
  | { method: "browserViewportSet"; width: number; height: number; tabId?: string }
  | { method: "browserViewportReset"; tabId?: string }
  | { method: "recordingStart"; options?: BrowserRecordingOptions; tabId?: string }
  | {
      method: "recordingStatus";
      recordingId: string;
      outputPath?: string;
      tabId?: string;
    }
  | { method: "recordingCancel"; recordingId: string; tabId?: string }
  | { method: "activateTab"; tabId: string }
  | { method: "newTab" }
  | { method: "listUserTabs" }
  | { method: "claimTab"; tabId: string }
  | {
      method: "finalizeTabs";
      keep: Array<{ tabId: string; status: "handoff" | "deliverable" }>;
    }
  | { method: "markDeliverable"; tabId: string }
  | { method: "markHandoff"; tabId: string }
  | { method: "nameSession"; name: string }
  | { method: "finalize"; tabId?: string; deliverable?: boolean }
  | { method: "turnEnded"; turnId?: string }
  | { method: "closeSession" }
  | { method: "cancelRequest"; requestId: string }
  // close：关闭指定受控 tab；manager 层处理。
  | { method: "close"; tabId?: string }
  // list：枚举当前会话窗口下所有受控 tab 摘要，manager 层拦截处理，返回 tabs。
  | { method: "list" };
