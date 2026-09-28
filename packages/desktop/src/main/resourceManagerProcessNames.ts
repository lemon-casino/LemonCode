import { BrowserWindow } from "electron";
import type { WebContents } from "electron";
import { basename } from "node:path";
import { formatLCodeRendererProcessName } from "@lcode/shared";

/** 资源管理器里非 BrowserWindow 自带 renderer（WebContentsView / DevTools / webview）的显示名 */

function normalizeProcessLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function pickUrlLabel(url: string | null | undefined): string | null {
  const normalizedUrl = normalizeProcessLabel(url);
  if (!normalizedUrl) return null;

  try {
    const parsed = new URL(normalizedUrl);
    if (parsed.protocol === "devtools:") {
      return "devtools";
    }

    if (parsed.protocol === "file:") {
      const fileName = basename(parsed.pathname);
      return normalizeProcessLabel(fileName) ?? "file";
    }

    return normalizeProcessLabel(parsed.hostname) ?? normalizeProcessLabel(parsed.protocol);
  } catch {
    return null;
  }
}

function pickWindowLabel(win: BrowserWindow | null): string | null {
  if (!win || win.isDestroyed()) return null;
  return normalizeProcessLabel(win.getTitle()) ?? `window-${win.id}`;
}

export function buildAuxiliaryRendererName(contents: WebContents): string {
  const type = contents.getType();
  const contentsId = contents.id;
  const title = normalizeProcessLabel(contents.getTitle());
  const url = normalizeProcessLabel(contents.getURL());
  const ownerWindow = BrowserWindow.fromWebContents(contents);
  const ownerLabel = pickWindowLabel(ownerWindow);
  const hostContents = contents.hostWebContents;
  const hostTitle = normalizeProcessLabel(hostContents?.getTitle());
  const hostUrlLabel = pickUrlLabel(hostContents?.getURL());
  const pageLabel =
    title ?? pickUrlLabel(url) ?? ownerLabel ?? hostTitle ?? hostUrlLabel ?? `wc-${contentsId}`;

  // 把 Electron 已知的 WebContents 元信息编码进名称里，排查 PID 时能直接看出类型和归属线索。
  if (url?.startsWith("devtools://")) {
    return formatLCodeRendererProcessName(
      `devtools-${contentsId}-${hostTitle ?? ownerLabel ?? "unknown"}`,
    );
  }

  if (type === "window") {
    return formatLCodeRendererProcessName(title ?? `window-${contentsId}`);
  }

  return formatLCodeRendererProcessName(`${type}-${contentsId}-${pageLabel}`);
}
