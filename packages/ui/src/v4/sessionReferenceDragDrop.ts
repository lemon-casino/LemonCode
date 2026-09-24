import { buildSessionMentionMarkdown } from "../mentions/mentionMarkdown.js";
import type { ComposerMentionPrefill } from "../store/zcodeSessionStoreTypes.js";

export const SESSION_REFERENCE_DRAG_MIME = "application/x-zcode-session-reference";
export const SESSION_REFERENCE_DRAG_VERSION = 1 as const;
export const SESSION_REFERENCE_ARM_DELAY_MS = 1500;

const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/u;
const SESSION_REFERENCE_RENDERER_AUTHORITY =
  typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `renderer-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export interface SessionReferenceDragPayload {
  readonly version: typeof SESSION_REFERENCE_DRAG_VERSION;
  readonly kind: "zcode/session-reference";
  /** renderer instance boundary；跨窗口/Host 的 native payload fail closed。 */
  readonly rendererAuthority: string;
  readonly sessionId: string;
  readonly source: {
    readonly workspacePath: string;
    readonly workspaceIdentity?: string;
    readonly remoteSessionId?: string;
  };
  readonly display?: {
    readonly title?: string;
  };
  /** 每次 dragstart 生成，防止 stale module state 被下一次 drop 误消费。 */
  readonly nonce: string;
}

export interface SessionReferenceTargetScope {
  readonly sessionId?: string | null;
  readonly workspacePath: string;
  readonly workspaceIdentity?: string;
  readonly remoteSessionId?: string | null;
}

export interface SessionReferenceDataTransferLike {
  readonly types?: Iterable<string> | ArrayLike<string>;
  getData(type: string): string;
}

export interface SessionReferencePointerTarget {
  readonly id: string;
  readonly element: HTMLElement;
  readonly onMove: (payload: SessionReferenceDragPayload, clientX: number, clientY: number) => void;
  readonly onLeave: (payload: SessionReferenceDragPayload) => void;
  readonly onDrop: (
    payload: SessionReferenceDragPayload,
    clientX: number,
    clientY: number,
  ) => boolean;
}

let activePointerSessionReference: SessionReferenceDragPayload | null = null;
const pointerTargets = new Map<string, SessionReferencePointerTarget>();
let activePointerTargetId: string | null = null;
let activePointerPosition: { clientX: number; clientY: number } | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function hasMimeType(dataTransfer: SessionReferenceDataTransferLike): boolean {
  return Array.from(dataTransfer.types ?? []).includes(SESSION_REFERENCE_DRAG_MIME);
}

function normalizePayload(value: unknown): SessionReferenceDragPayload | null {
  if (!isRecord(value)) return null;
  if (
    value.version !== SESSION_REFERENCE_DRAG_VERSION ||
    value.kind !== "zcode/session-reference" ||
    value.rendererAuthority !== SESSION_REFERENCE_RENDERER_AUTHORITY ||
    typeof value.sessionId !== "string" ||
    !SESSION_ID_PATTERN.test(value.sessionId) ||
    typeof value.nonce !== "string" ||
    value.nonce.length < 8 ||
    !isRecord(value.source) ||
    typeof value.source.workspacePath !== "string" ||
    value.source.workspacePath.trim().length === 0
  ) {
    return null;
  }

  const workspaceIdentity = readOptionalString(value.source.workspaceIdentity);
  const remoteSessionId = readOptionalString(value.source.remoteSessionId);
  // 远程路由不能只靠 workspacePath 推断；缺 identity 时 fail closed。
  if (remoteSessionId && !workspaceIdentity) return null;

  const display = isRecord(value.display)
    ? (() => {
        const title = readOptionalString(value.display.title)?.slice(0, 160);
        return title ? { title } : undefined;
      })()
    : undefined;

  return {
    version: SESSION_REFERENCE_DRAG_VERSION,
    kind: "zcode/session-reference",
    rendererAuthority: SESSION_REFERENCE_RENDERER_AUTHORITY,
    sessionId: value.sessionId,
    source: {
      workspacePath: value.source.workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    },
    ...(display ? { display } : {}),
    nonce: value.nonce,
  };
}

export function createSessionReferenceDragPayload(input: {
  sessionId: string;
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  title?: string;
  nonce?: string;
}): SessionReferenceDragPayload | null {
  const normalized = normalizePayload({
    version: SESSION_REFERENCE_DRAG_VERSION,
    kind: "zcode/session-reference",
    rendererAuthority: SESSION_REFERENCE_RENDERER_AUTHORITY,
    sessionId: input.sessionId,
    source: {
      workspacePath: input.workspacePath,
      ...(input.workspaceIdentity?.trim() ? { workspaceIdentity: input.workspaceIdentity } : {}),
      ...(input.remoteSessionId?.trim() ? { remoteSessionId: input.remoteSessionId } : {}),
    },
    ...(input.title?.trim() ? { display: { title: input.title } } : {}),
    nonce: input.nonce ?? createSessionReferenceDragNonce(),
  });
  return normalized;
}

export function createSessionReferenceDragNonce(): string {
  const random =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `session-reference-${random}`;
}

export function serializeSessionReferenceDragPayload(payload: SessionReferenceDragPayload): string {
  return JSON.stringify(payload);
}

export function parseSessionReferenceDragPayload(
  dataTransfer: SessionReferenceDataTransferLike,
): SessionReferenceDragPayload | null {
  if (!hasMimeType(dataTransfer)) return null;
  try {
    const raw = dataTransfer.getData(SESSION_REFERENCE_DRAG_MIME);
    return raw ? normalizePayload(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * HTML DnD protected mode 在 dragover 阶段可能只暴露 types，正文要到 drop 才可读。
 * 这里的 renderer-local fallback 仅用于预热视觉；drop 必须继续调用严格 parser。
 */
export function resolveSessionReferenceDragOverPayload(
  dataTransfer: SessionReferenceDataTransferLike,
): SessionReferenceDragPayload | null {
  if (!hasMimeType(dataTransfer)) return null;
  let raw: string;
  try {
    raw = dataTransfer.getData(SESSION_REFERENCE_DRAG_MIME);
  } catch {
    return activePointerSessionReference;
  }
  if (!raw) return activePointerSessionReference;
  try {
    return normalizePayload(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function setActivePointerSessionReference(payload: SessionReferenceDragPayload): void {
  activePointerSessionReference = payload;
  activePointerTargetId = null;
  activePointerPosition = null;
}

export function readActivePointerSessionReference(): SessionReferenceDragPayload | null {
  return activePointerSessionReference;
}

export function clearActivePointerSessionReference(nonce?: string): void {
  if (!nonce || activePointerSessionReference?.nonce === nonce) {
    activePointerSessionReference = null;
    activePointerTargetId = null;
    activePointerPosition = null;
  }
}

export function registerSessionReferencePointerTarget(
  target: SessionReferencePointerTarget,
): () => void {
  pointerTargets.set(target.id, target);
  return () => {
    if (activePointerTargetId === target.id && activePointerSessionReference) {
      // Pane 卸载/重绑定时清掉目标本地 timer，但保留 source payload，
      // 让同一 pointer drag 继续进入另一个可编辑 Pane。
      target.onLeave(activePointerSessionReference);
    }
    pointerTargets.delete(target.id);
    if (activePointerTargetId === target.id) {
      activePointerTargetId = null;
    }
  };
}

function resolvePointerTarget(
  clientX: number,
  clientY: number,
): SessionReferencePointerTarget | null {
  if (typeof document === "undefined") return null;
  const element = document.elementFromPoint(clientX, clientY);
  if (!element) return null;
  for (const target of pointerTargets.values()) {
    if (target.element.contains(element)) return target;
  }
  return null;
}

export function updateSessionReferencePointerDrag(clientX: number, clientY: number): void {
  const payload = activePointerSessionReference;
  if (!payload) return;
  activePointerPosition = { clientX, clientY };
  const target = resolvePointerTarget(clientX, clientY);
  if (target?.id !== activePointerTargetId && activePointerTargetId) {
    pointerTargets.get(activePointerTargetId)?.onLeave(payload);
  }
  activePointerTargetId = target?.id ?? null;
  target?.onMove(payload, clientX, clientY);
}

export function finishSessionReferencePointerDrag(
  expectedNonce?: string,
  finalPosition?: { readonly clientX: number; readonly clientY: number },
): boolean {
  const payload = activePointerSessionReference;
  if (!payload || (expectedNonce && payload.nonce !== expectedNonce)) return false;
  if (finalPosition) {
    // dnd-kit 的最后一次 move 可能早于 pointerup；提交必须以 tracker 的最终坐标为准。
    updateSessionReferencePointerDrag(finalPosition.clientX, finalPosition.clientY);
  }
  const position = activePointerPosition;
  const target =
    (activePointerTargetId ? pointerTargets.get(activePointerTargetId) : null) ??
    (position ? resolvePointerTarget(position.clientX, position.clientY) : null);
  try {
    return Boolean(
      payload && target && position && target.onDrop(payload, position.clientX, position.clientY),
    );
  } finally {
    clearActivePointerSessionReference(payload.nonce);
  }
}

export function cancelSessionReferencePointerDrag(expectedNonce?: string): void {
  const payload = activePointerSessionReference;
  if (!payload || (expectedNonce && payload.nonce !== expectedNonce)) return;
  const target =
    (activePointerTargetId ? pointerTargets.get(activePointerTargetId) : null) ??
    (activePointerPosition
      ? resolvePointerTarget(activePointerPosition.clientX, activePointerPosition.clientY)
      : null);
  try {
    target?.onLeave(payload);
  } finally {
    clearActivePointerSessionReference(payload.nonce);
  }
}

/**
 * 当前 Host 才能读取 session history。远程 scope 必须共享 endpoint，
 * 本地 scope 允许同一 Agent service 下跨 workspace 引用。
 */
export function canAcceptSessionReference(
  payload: SessionReferenceDragPayload,
  target: SessionReferenceTargetScope,
): boolean {
  if (payload.rendererAuthority !== SESSION_REFERENCE_RENDERER_AUTHORITY) return false;
  if (!SESSION_ID_PATTERN.test(payload.sessionId)) return false;
  if (target.sessionId && target.sessionId === payload.sessionId) return false;

  const sourceWorkspaceIdentity = payload.source.workspaceIdentity?.trim() || null;
  const targetWorkspaceIdentity = target.workspaceIdentity?.trim() || null;
  const sourceRemote = payload.source.remoteSessionId?.trim() || null;
  const targetRemote = target.remoteSessionId?.trim() || null;
  if (sourceRemote || targetRemote || sourceWorkspaceIdentity || targetWorkspaceIdentity) {
    // endpoint 才是 Agent service authority；workspace identity 仍必须成对携带，
    // 但同一 remote Host 可按现有 # mention 规则跨 workspace 读取 session index。
    return Boolean(
      sourceRemote &&
      targetRemote &&
      sourceWorkspaceIdentity &&
      targetWorkspaceIdentity &&
      sourceRemote === targetRemote,
    );
  }

  // 没有 identity/remote route 表示同一本地 Agent service；本地会话允许跨 workspace 引用。
  return true;
}

export function buildSessionReferenceMention(
  payload: SessionReferenceDragPayload,
): ComposerMentionPrefill {
  const title =
    payload.display?.title?.replace(/^#sess_[A-Za-z0-9._-]+\s*/u, "").trim() || payload.sessionId;
  return {
    id: `session:${payload.sessionId}`,
    category: "sessions",
    label: title,
    value: payload.sessionId,
    markdown: buildSessionMentionMarkdown(payload.sessionId, title),
    description: payload.source.workspacePath,
  };
}

export function hasSessionReferenceMention(markdown: string, sessionId: string): boolean {
  const escaped = sessionId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`#${escaped}(?=$|[^A-Za-z0-9._-])`, "u").test(markdown);
}
