/* oxlint-disable eslint(max-lines) -- Protocol normalization and the single serialized state owner stay colocated. */
const MAX_IDENTIFIER_LENGTH = 255;
const MAX_SESSIONS = 256;
const MAX_EVENT_IDS_PER_SESSION = 64;
const MAX_FOCUS_EVENT_IDS = 256;
const MAX_PENDING_CAPTURES = 16;
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
const MAX_RETAINED_CAPTURE_BYTES = 64 * 1024 * 1024;
const DEFAULT_PENDING_CAPTURE_TTL_MS = 2_000;
const MAX_CAPTURE_BASE64_LENGTH = Math.ceil(MAX_CAPTURE_BYTES / 3) * 4;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value
    ? value
    : undefined;
}

function optionalSequence(value) {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function commonLifecycle(event, requiredTurnId = false) {
  const sessionId = identifier(event.sessionId);
  const turnId = event.turnId === undefined ? undefined : identifier(event.turnId);
  const eventId = event.eventId === undefined ? undefined : identifier(event.eventId);
  if (!sessionId || (requiredTurnId && !turnId) || !optionalSequence(event.sequenceNumber)) {
    return undefined;
  }
  if (event.turnId !== undefined && !turnId) return undefined;
  if (event.eventId !== undefined && !eventId) return undefined;
  return {
    ...event,
    sessionId,
    ...(turnId ? { turnId } : {}),
    ...(eventId ? { eventId } : {}),
  };
}

export function normalizePipSessionEvent(value) {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  switch (value.kind) {
    case "turn-started": {
      if (
        !hasExactKeys(value, new Set(["kind", "sessionId", "turnId", "sequenceNumber", "eventId"]))
      ) {
        return undefined;
      }
      return commonLifecycle(value, true);
    }
    case "focus-changed": {
      if (
        !hasExactKeys(
          value,
          new Set(["kind", "sessionId", "revision", "sourceWindowId", "sequenceNumber", "eventId"]),
        ) ||
        (value.sessionId !== null && !identifier(value.sessionId)) ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        !identifier(value.sourceWindowId) ||
        !optionalSequence(value.sequenceNumber) ||
        (value.eventId !== undefined && !identifier(value.eventId))
      ) {
        return undefined;
      }
      return {
        ...value,
        sessionId: value.sessionId === null ? null : identifier(value.sessionId),
        sourceWindowId: identifier(value.sourceWindowId),
        ...(value.eventId === undefined ? {} : { eventId: identifier(value.eventId) }),
      };
    }
    case "turn-ended":
    case "turn-completed":
    case "turn-failed": {
      if (
        !hasExactKeys(
          value,
          new Set(["kind", "sessionId", "turnId", "sequenceNumber", "eventId", "outcome"]),
        ) ||
        (value.outcome !== undefined && value.outcome !== "completed" && value.outcome !== "failed")
      ) {
        return undefined;
      }
      return commonLifecycle(value, true);
    }
    case "tool-scheduled":
    case "tool-started": {
      if (
        !hasExactKeys(
          value,
          new Set(["kind", "sessionId", "turnId", "sequenceNumber", "eventId", "toolCallId"]),
        ) ||
        !identifier(value.toolCallId)
      ) {
        return undefined;
      }
      return commonLifecycle(value, true);
    }
    case "session-closed": {
      if (
        !hasExactKeys(value, new Set(["kind", "sessionId", "turnId", "sequenceNumber", "eventId"]))
      ) {
        return undefined;
      }
      return commonLifecycle(value, false);
    }
    default:
      return undefined;
  }
}

export function normalizePipSessionSnapshot(value) {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, new Set(["turns", "focus"])) ||
    !Array.isArray(value.turns) ||
    value.turns.length > MAX_SESSIONS
  ) {
    return undefined;
  }
  const turns = [];
  const sessionIds = new Set();
  for (const candidate of value.turns) {
    const event = normalizePipSessionEvent(candidate);
    if (!event || event.kind !== "turn-started" || sessionIds.has(event.sessionId))
      return undefined;
    sessionIds.add(event.sessionId);
    turns.push(event);
  }
  const focus = value.focus === undefined ? undefined : normalizePipSessionEvent(value.focus);
  if (value.focus !== undefined && (!focus || focus.kind !== "focus-changed")) return undefined;
  return { turns, ...(focus ? { focus } : {}) };
}

function decodeCapturePng(data, width, height) {
  if (
    typeof data !== "string" ||
    data.length === 0 ||
    data.length > MAX_CAPTURE_BASE64_LENGTH ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(data)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(data, "base64");
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CAPTURE_BYTES ||
    bytes.toString("base64") !== data ||
    bytes.length < 33 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR" ||
    bytes.readUInt32BE(16) !== width ||
    bytes.readUInt32BE(20) !== height
  ) {
    return undefined;
  }
  return data;
}

function normalizeCapture(value) {
  if (!isRecord(value)) return undefined;
  const sessionId = identifier(value.sessionId);
  const turnId = identifier(value.turnId);
  const frameId = identifier(value.frameId);
  const title = value.title === undefined ? undefined : identifier(value.title);
  if (
    !sessionId ||
    !turnId ||
    !frameId ||
    value.mimeType !== "image/png" ||
    !Number.isSafeInteger(value.width) ||
    value.width <= 0 ||
    !Number.isSafeInteger(value.height) ||
    value.height <= 0 ||
    (value.title !== undefined && !title)
  ) {
    return undefined;
  }
  const data = decodeCapturePng(value.data, value.width, value.height);
  if (!data) return undefined;
  return {
    sessionId,
    turnId,
    frameId,
    mimeType: "image/png",
    data,
    width: value.width,
    height: value.height,
    ...(title ? { title } : {}),
  };
}

function copySession(record) {
  return {
    ...record,
    eventIds: new Set(record.eventIds),
    eventIdOrder: [...record.eventIdOrder],
  };
}

function copyState(state) {
  return {
    sessions: new Map([...state.sessions].map(([key, value]) => [key, copySession(value)])),
    focus: state.focus ? { ...state.focus } : undefined,
    focusEventIds: new Set(state.focusEventIds),
    focusEventIdOrder: [...state.focusEventIdOrder],
    pendingCaptures: new Map(
      [...state.pendingCaptures].map(([key, value]) => [
        key,
        { ...value, capture: { ...value.capture } },
      ]),
    ),
    visible: state.visible ? { ...state.visible } : undefined,
    clock: state.clock,
  };
}

function captureByteLength(capture) {
  const padding = capture.data.endsWith("==") ? 2 : capture.data.endsWith("=") ? 1 : 0;
  return (capture.data.length / 4) * 3 - padding;
}

function retainedCaptureBytes(state) {
  let total = 0;
  for (const session of state.sessions.values()) {
    if (session.capture) total += captureByteLength(session.capture);
  }
  for (const pending of state.pendingCaptures.values()) {
    total += captureByteLength(pending.capture);
  }
  return total;
}

function addBoundedId(ids, order, id, maximum) {
  if (!id || ids.has(id)) return;
  ids.add(id);
  order.push(id);
  while (order.length > maximum) {
    const removed = order.shift();
    if (removed) ids.delete(removed);
  }
}

function desiredPresentation(state) {
  const sessionId = state.focus?.sessionId;
  if (!sessionId) return undefined;
  const session = state.sessions.get(sessionId);
  if (!session?.turnId || !session.capture) return undefined;
  return session.capture.turnId === session.turnId ? session.capture : undefined;
}

function evictIdleSession(state) {
  let candidate;
  for (const [sessionId, session] of state.sessions) {
    if (session.turnId) continue;
    if (!candidate || session.touchedAt < candidate[1].touchedAt) candidate = [sessionId, session];
  }
  if (!candidate) return false;
  state.sessions.delete(candidate[0]);
  state.pendingCaptures.delete(candidate[0]);
  return true;
}

function getSession(state, sessionId) {
  let session = state.sessions.get(sessionId);
  if (session) return session;
  if (state.sessions.size >= MAX_SESSIONS && !evictIdleSession(state)) return undefined;
  session = {
    turnId: undefined,
    lastSequence: undefined,
    capture: undefined,
    eventIds: new Set(),
    eventIdOrder: [],
    touchedAt: ++state.clock,
  };
  state.sessions.set(sessionId, session);
  return session;
}

function purgeExpiredPending(state, now) {
  for (const [sessionId, pending] of state.pendingCaptures) {
    if (pending.expiresAt <= now) state.pendingCaptures.delete(sessionId);
  }
}

function addPendingCapture(state, capture, expiresAt, maxRetainedCaptureBytes) {
  state.pendingCaptures.set(capture.sessionId, { capture, expiresAt, insertedAt: ++state.clock });
  while (state.pendingCaptures.size > MAX_PENDING_CAPTURES) {
    let oldest;
    for (const entry of state.pendingCaptures) {
      if (!oldest || entry[1].insertedAt < oldest[1].insertedAt) oldest = entry;
    }
    if (!oldest) break;
    state.pendingCaptures.delete(oldest[0]);
  }
  return retainedCaptureBytes(state) <= maxRetainedCaptureBytes;
}

export function createPipSessionCoordinator(options = {}) {
  const presenter = options.presenter;
  if (
    !presenter ||
    typeof presenter.show !== "function" ||
    typeof presenter.hide !== "function" ||
    typeof presenter.dispose !== "function"
  ) {
    throw new TypeError("PiP presenter is required");
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  const pendingCaptureTtlMs =
    Number.isFinite(options.pendingCaptureTtlMs) && options.pendingCaptureTtlMs > 0
      ? options.pendingCaptureTtlMs
      : DEFAULT_PENDING_CAPTURE_TTL_MS;
  const maxRetainedCaptureBytes =
    Number.isSafeInteger(options.maxRetainedCaptureBytes) && options.maxRetainedCaptureBytes > 0
      ? Math.min(options.maxRetainedCaptureBytes, MAX_RETAINED_CAPTURE_BYTES)
      : MAX_RETAINED_CAPTURE_BYTES;
  let state = {
    sessions: new Map(),
    focus: undefined,
    focusEventIds: new Set(),
    focusEventIdOrder: [],
    pendingCaptures: new Map(),
    visible: undefined,
    clock: 0,
  };
  let tail = Promise.resolve();
  let disposed = false;

  const enqueue = (work) => {
    const operation = tail.then(work);
    tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  async function reconcile(next) {
    const desired = desiredPresentation(next);
    const current = state.visible;
    if (!desired) {
      if (current) await presenter.hide();
      next.visible = undefined;
      return;
    }
    if (
      current?.sessionId === desired.sessionId &&
      current.turnId === desired.turnId &&
      current.frameId === desired.frameId
    ) {
      next.visible = current;
      return;
    }
    await presenter.show({ ...desired });
    next.visible = {
      sessionId: desired.sessionId,
      turnId: desired.turnId,
      frameId: desired.frameId,
    };
  }

  const commit = (mutate) =>
    enqueue(async () => {
      if (disposed)
        throw Object.assign(new Error("PiP coordinator is disposed"), { code: "disposed" });
      const next = copyState(state);
      purgeExpiredPending(next, now());
      const outcome = mutate(next);
      if (!outcome.commit) return outcome.result;
      await reconcile(next);
      state = next;
      return outcome.result;
    });

  function applyLifecycle(next, event) {
    const session = getSession(next, event.sessionId);
    if (!session) return { commit: false, result: { applied: false, reason: "capacity" } };
    if (event.eventId && session.eventIds.has(event.eventId)) {
      return { commit: false, result: { applied: false, reason: "duplicate-event" } };
    }
    if (
      event.sequenceNumber !== undefined &&
      session.lastSequence !== undefined &&
      event.sequenceNumber <= session.lastSequence
    ) {
      return { commit: false, result: { applied: false, reason: "stale-sequence" } };
    }
    if (event.sequenceNumber !== undefined) session.lastSequence = event.sequenceNumber;
    addBoundedId(session.eventIds, session.eventIdOrder, event.eventId, MAX_EVENT_IDS_PER_SESSION);
    session.touchedAt = ++next.clock;

    if (event.kind === "turn-started") {
      const existingCapture = session.turnId === event.turnId ? session.capture : undefined;
      session.turnId = event.turnId;
      session.capture = existingCapture;
      const pending = next.pendingCaptures.get(event.sessionId);
      if (pending?.capture.turnId === event.turnId) {
        session.capture = pending.capture;
        next.pendingCaptures.delete(event.sessionId);
      }
      return { commit: true, result: { applied: true } };
    }
    if (event.kind === "session-closed") {
      session.turnId = undefined;
      session.capture = undefined;
      next.pendingCaptures.delete(event.sessionId);
      return { commit: true, result: { applied: true } };
    }
    if (session.turnId !== event.turnId) {
      return { commit: true, result: { applied: false, reason: "turn-mismatch" } };
    }
    if (
      event.kind === "turn-ended" ||
      event.kind === "turn-completed" ||
      event.kind === "turn-failed"
    ) {
      session.turnId = undefined;
      session.capture = undefined;
      next.pendingCaptures.delete(event.sessionId);
    }
    return { commit: true, result: { applied: true } };
  }

  return {
    applySnapshot(snapshotInput) {
      const snapshot = normalizePipSessionSnapshot(snapshotInput);
      if (!snapshot) {
        return Promise.reject(
          Object.assign(new Error("PiP snapshot is invalid"), { code: "invalid_request" }),
        );
      }
      return commit((next) => {
        const replacement = new Map();
        for (const event of snapshot.turns) {
          const previous = next.sessions.get(event.sessionId);
          const pending = next.pendingCaptures.get(event.sessionId);
          // 根因：冷启动时截图可能先于认证快照到达；只在实时 turn-started 消费 pending
          // 会让已恢复的 open turn 永久等到下一张截图。快照建立同一 turn 时必须原子转移所有权。
          const pendingCapture =
            pending?.capture.turnId === event.turnId ? pending.capture : undefined;
          if (pendingCapture) next.pendingCaptures.delete(event.sessionId);
          replacement.set(event.sessionId, {
            turnId: event.turnId,
            lastSequence: event.sequenceNumber,
            capture:
              pendingCapture ?? (previous?.turnId === event.turnId ? previous.capture : undefined),
            eventIds: new Set(event.eventId ? [event.eventId] : []),
            eventIdOrder: event.eventId ? [event.eventId] : [],
            touchedAt: ++next.clock,
          });
        }
        next.sessions = replacement;
        next.focus = snapshot.focus ? { ...snapshot.focus } : undefined;
        next.focusEventIds = new Set(snapshot.focus?.eventId ? [snapshot.focus.eventId] : []);
        next.focusEventIdOrder = snapshot.focus?.eventId ? [snapshot.focus.eventId] : [];
        for (const sessionId of next.pendingCaptures.keys()) {
          if (!replacement.has(sessionId)) next.pendingCaptures.delete(sessionId);
        }
        return { commit: true, result: { applied: true } };
      });
    },

    applyEvent(eventInput) {
      const event = normalizePipSessionEvent(eventInput);
      if (!event) {
        return Promise.reject(
          Object.assign(new Error("PiP event is invalid"), { code: "invalid_request" }),
        );
      }
      return commit((next) => {
        if (event.kind !== "focus-changed") return applyLifecycle(next, event);
        if (event.eventId && next.focusEventIds.has(event.eventId)) {
          return { commit: false, result: { applied: false, reason: "duplicate-event" } };
        }
        if (next.focus && event.revision <= next.focus.revision) {
          return { commit: false, result: { applied: false, reason: "stale-revision" } };
        }
        next.focus = { ...event };
        addBoundedId(
          next.focusEventIds,
          next.focusEventIdOrder,
          event.eventId,
          MAX_FOCUS_EVENT_IDS,
        );
        return { commit: true, result: { applied: true } };
      });
    },

    bindCapture(captureInput) {
      const capture = normalizeCapture(captureInput);
      if (!capture) {
        return Promise.resolve({ accepted: false, reason: "invalid-capture" });
      }
      return commit((next) => {
        const session = next.sessions.get(capture.sessionId);
        if (!session?.turnId) {
          // 根因：数量上限仍允许 256 个 session 各持有 32 MiB 截图；聚合预算必须在
          // 克隆态提交前同时核算 session 与 pending，超限时原状态和 presenter 都不变。
          if (
            !addPendingCapture(next, capture, now() + pendingCaptureTtlMs, maxRetainedCaptureBytes)
          ) {
            return {
              commit: false,
              result: { accepted: false, reason: "capture-capacity" },
            };
          }
          return { commit: true, result: { accepted: true, pending: true } };
        }
        if (session.turnId !== capture.turnId) {
          return {
            commit: false,
            result: { accepted: false, reason: "turn-mismatch" },
          };
        }
        session.capture = capture;
        if (retainedCaptureBytes(next) > maxRetainedCaptureBytes) {
          return {
            commit: false,
            result: { accepted: false, reason: "capture-capacity" },
          };
        }
        session.touchedAt = ++next.clock;
        next.pendingCaptures.delete(capture.sessionId);
        return { commit: true, result: { accepted: true, pending: false } };
      });
    },

    inspect() {
      return {
        disposed,
        focus: state.focus ? { ...state.focus } : undefined,
        sessions: [...state.sessions].map(([sessionId, session]) => ({
          sessionId,
          turnId: session.turnId,
          lastSequence: session.lastSequence,
          frameId: session.capture?.frameId,
        })),
        pendingSessions: [...state.pendingCaptures.keys()],
        visible: state.visible ? { ...state.visible } : undefined,
      };
    },

    dispose() {
      return enqueue(async () => {
        if (disposed) return;
        disposed = true;
        try {
          if (state.visible) await presenter.hide();
        } finally {
          await presenter.dispose();
          state.sessions.clear();
          state.pendingCaptures.clear();
          state.visible = undefined;
          state.focus = undefined;
        }
      });
    },
  };
}
