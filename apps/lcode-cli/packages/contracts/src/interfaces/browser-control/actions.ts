import type {
  BrowserKeyModifier,
  BrowserMouseButton,
  BrowserPoint,
  BrowserViewportSize,
} from "./context.js";

export type BrowserPlaywrightModifier = BrowserKeyModifier;

export type BrowserPlaywrightLocatorOperation =
  | "allTextContents"
  | "click"
  | "count"
  | "dblclick"
  | "downloadMedia"
  | "evaluate"
  | "fill"
  | "getAttribute"
  | "innerText"
  | "isEnabled"
  | "isVisible"
  | "press"
  | "selectOption"
  | "setChecked"
  | "textContent"
  | "waitFor";

export type BrowserPlaywrightAction =
  | { name: "domSnapshot" }
  | { name: "elementInfo"; x: number; y: number; includeNonInteractable?: boolean }
  | { name: "elementScreenshot"; x: number; y: number; includeNonInteractable?: boolean }
  | {
      name: "evaluate";
      expression: string;
      expressionKind: "string" | "function";
      arg?: unknown;
      timeoutMs?: number;
    }
  | {
      name: "waitForLoadState";
      state?: "load" | "domcontentloaded" | "networkidle";
      timeoutMs?: number;
    }
  | {
      name: "waitForURL";
      url: string;
      waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit";
      timeoutMs?: number;
    }
  | { name: "waitForEvent"; event: "download" | "filechooser"; timeoutMs?: number }
  | { name: "downloadPath"; downloadId: string; timeoutMs?: number }
  | {
      name: "fileChooserSetFiles";
      fileChooserId: string;
      files: string[];
      timeoutMs?: number;
    }
  | {
      name: "locator";
      selector: string;
      operation: BrowserPlaywrightLocatorOperation;
      value?: unknown;
      arg?: unknown;
      expression?: string;
      expressionKind?: "string" | "function";
      attribute?: string;
      checked?: boolean;
      replace?: boolean;
      force?: boolean;
      button?: BrowserMouseButton;
      modifiers?: BrowserPlaywrightModifier[];
      state?: "attached" | "detached" | "visible" | "hidden";
      selections?: Array<{ value?: string; label?: string; index?: number }>;
      timeoutMs?: number;
    };

export type BrowserRecordingAction =
  | { type: "wait"; durationMs: number }
  | {
      type: "click";
      selector?: string;
      x?: number;
      y?: number;
      button?: BrowserMouseButton;
      doubleClick?: boolean;
      delayAfterMs?: number;
    }
  | { type: "type"; selector: string; text: string; delayAfterMs?: number }
  | {
      type: "hover";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | { type: "move"; x: number; y: number; durationMs?: number; delayAfterMs?: number }
  | {
      type: "scroll";
      deltaX?: number;
      deltaY: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "scrollTo";
      selector?: string;
      x?: number;
      y?: number;
      durationMs?: number;
      delayAfterMs?: number;
    }
  | {
      type: "wheel";
      deltaX?: number;
      deltaY: number;
      times?: number;
      intervalMs?: number;
      delayAfterMs?: number;
    }
  | { type: "drag"; path: BrowserPoint[]; durationMs?: number; delayAfterMs?: number }
  | {
      type: "waitFor";
      selector: string;
      state?: "attached" | "detached" | "visible" | "hidden";
      timeoutMs?: number;
      delayAfterMs?: number;
    };

export interface BrowserRecordingOptions {
  viewport?: BrowserViewportSize;
  fps?: number;
  jpegQuality?: number;
  maxDurationMs?: number;
  settleMs?: number;
  showCursor?: boolean;
  actions?: BrowserRecordingAction[];
}

export interface BrowserRecordingArtifact {
  path: string;
  mimeType: "video/webm";
  width: number;
  height: number;
  fps: number;
  durationMs: number;
  frameCount: number;
}

export interface BrowserRecordingJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "preparing" | "capturing" | "finalizing" | "completed" | "failed" | "cancelled";
  progress: number;
  startedAt: number;
  updatedAt: number;
  artifact?: BrowserRecordingArtifact;
  error?: string;
}
