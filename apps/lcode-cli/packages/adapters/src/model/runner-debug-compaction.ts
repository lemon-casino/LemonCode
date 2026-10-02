const FINGERPRINT_STRING_LIMIT = 512;

interface ModelIOCollectionState {
  count: number;
  firstFingerprint?: string;
  lastFingerprint?: string;
  sampleFingerprints?: string[];
}

interface ModelIORequestCompactionState {
  bodyMessages?: ModelIOCollectionState;
  messages?: ModelIOCollectionState;
  sdkMessages?: ModelIOCollectionState;
}

export interface ModelIOCompactionState {
  request?: ModelIORequestCompactionState;
}

export function prepareModelIORecordForWrite(
  record: Record<string, unknown>,
  isDev: boolean,
): Record<string, unknown> {
  if (isDev) {
    return record;
  }

  const request = asRecord(record.request);
  const response = asRecord(record.response);
  return {
    ...record,
    request: request ? prepareProductionRequestRecord(request, Boolean(record.error)) : request,
    response: response ? prepareProductionResponseRecord(response) : response,
  };
}

function prepareProductionRequestRecord(
  request: Record<string, unknown>,
  hasError: boolean,
): Record<string, unknown> {
  const next = { ...request };
  // 生产 rollout 只保留 canonical request.messages。sdkMessages 与 provider body.messages
  // 通常是同一上下文的重复拷贝，长会话下会把诊断文件和单次 stringify 放大数倍。
  delete next.sdkMessages;
  const body = asRecord(next.body);
  if (body && !hasError) {
    const nextBody = { ...body };
    delete nextBody.messages;
    next.body = nextBody;
  }
  return next;
}

function prepareProductionResponseRecord(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...response };
  // response.body 在生产排障里价值低于 text/toolCalls/usage/finishReason，且可能包含 provider 原始大包。
  delete next.body;
  return next;
}

export function compactModelIORecord(
  record: Record<string, unknown>,
  previousState: ModelIOCompactionState | undefined,
  options: { maxBaselineMessages: number; preserveFullBodyMessages?: boolean },
): Record<string, unknown> {
  const request = asRecord(record.request);
  if (!request) {
    return record;
  }

  return {
    ...record,
    request: compactModelIORequest(request, previousState?.request, options),
  };
}

function compactModelIORequest(
  request: Record<string, unknown>,
  previousState: ModelIORequestCompactionState | undefined,
  options: { maxBaselineMessages: number; preserveFullBodyMessages?: boolean },
): Record<string, unknown> {
  const next = { ...request };
  compactMessageCollection(
    next,
    previousState?.messages,
    {
      collectionKey: "messages",
      countKey: "messageCount",
      kindKey: "messagesKind",
      offsetKey: "messageOffset",
    },
    options,
  );
  compactMessageCollection(
    next,
    previousState?.sdkMessages,
    {
      collectionKey: "sdkMessages",
      countKey: "sdkMessageCount",
      kindKey: "sdkMessagesKind",
      offsetKey: "sdkMessageOffset",
    },
    options,
  );

  const body = asRecord(next.body);
  if (body) {
    const nextBody = { ...body };
    const bodyMessageKeys = {
      collectionKey: "messages",
      countKey: "bodyMessageCount",
      kindKey: "bodyMessagesKind",
      offsetKey: "bodyMessageOffset",
    };
    if (options.preserveFullBodyMessages && Array.isArray(nextBody.messages)) {
      // provider 400 等失败排障需要 exact request payload；失败记录若继续
      // 按上一条 model-io 做 delta，会把最关键的完整 messages 丢在导出包之外。
      next[bodyMessageKeys.countKey] = nextBody.messages.length;
      next[bodyMessageKeys.kindKey] = "full";
      next[bodyMessageKeys.offsetKey] = 0;
    } else {
      compactMessageCollection(
        nextBody,
        previousState?.bodyMessages,
        bodyMessageKeys,
        options,
        next,
      );
    }
    next.body = nextBody;
  }

  return next;
}

function compactMessageCollection(
  target: Record<string, unknown>,
  previousState: ModelIOCollectionState | undefined,
  keys: {
    collectionKey: string;
    countKey: string;
    kindKey: string;
    offsetKey: string;
  },
  options: { maxBaselineMessages: number },
  metadataTarget: Record<string, unknown> = target,
): void {
  const currentMessages = target[keys.collectionKey];
  if (!Array.isArray(currentMessages)) {
    return;
  }

  metadataTarget[keys.countKey] = currentMessages.length;
  if (canStoreDeltaFromState(currentMessages, previousState)) {
    // 后续 model-io 只记录相对上一请求新增的消息，避免完整历史在同一 session 内梯度重复。
    // previousState 来自进程内缓存，不再为 append 同步读取并 expand 整个历史 JSONL。
    target[keys.collectionKey] = currentMessages.slice(previousState.count);
    metadataTarget[keys.kindKey] = "delta";
    metadataTarget[keys.offsetKey] = previousState.count;
    return;
  }

  const maxBaselineMessages = Math.max(1, options.maxBaselineMessages);
  if (currentMessages.length > maxBaselineMessages) {
    const offset = currentMessages.length - maxBaselineMessages;
    target[keys.collectionKey] = currentMessages.slice(offset);
    metadataTarget[keys.kindKey] = "tail";
    metadataTarget[keys.offsetKey] = offset;
    return;
  }

  metadataTarget[keys.kindKey] = "full";
  metadataTarget[keys.offsetKey] = 0;
}

function canStoreDeltaFromState(
  currentMessages: unknown[],
  previousState: ModelIOCollectionState | undefined,
): previousState is ModelIOCollectionState {
  if (!previousState || previousState.count <= 0 || currentMessages.length < previousState.count) {
    return false;
  }
  const firstFingerprint = fingerprintValue(currentMessages[0]);
  const lastFingerprint = fingerprintValue(currentMessages[previousState.count - 1]);
  return (
    firstFingerprint === previousState.firstFingerprint &&
    lastFingerprint === previousState.lastFingerprint &&
    hasSameSampleFingerprints(currentMessages, previousState)
  );
}

export function buildModelIOCompactionState(
  record: Record<string, unknown>,
): ModelIOCompactionState {
  const request = asRecord(record.request);
  if (!request) {
    return {};
  }

  return {
    request: buildRequestCompactionState(request),
  };
}

function buildRequestCompactionState(
  request: Record<string, unknown>,
): ModelIORequestCompactionState {
  const body = asRecord(request.body);
  return {
    bodyMessages: buildCollectionState(body?.messages),
    messages: buildCollectionState(request.messages),
    sdkMessages: buildCollectionState(request.sdkMessages),
  };
}

function buildCollectionState(value: unknown): ModelIOCollectionState | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return {
    count: value.length,
    firstFingerprint: fingerprintValue(value[0]),
    lastFingerprint: fingerprintValue(value[value.length - 1]),
    sampleFingerprints: fingerprintCollectionSamples(value),
  };
}

function hasSameSampleFingerprints(
  currentMessages: unknown[],
  previousState: ModelIOCollectionState,
): boolean {
  const previousSamples = previousState.sampleFingerprints;
  if (!previousSamples) {
    return true;
  }
  const currentSamples = fingerprintCollectionSamples(currentMessages, previousState.count);
  return (
    currentSamples.length === previousSamples.length &&
    currentSamples.every((fingerprint, index) => fingerprint === previousSamples[index])
  );
}

function fingerprintCollectionSamples(value: unknown[], count = value.length): string[] {
  if (count <= 0) {
    return [];
  }
  // 常数级采样首/中/尾位置，避免把整段历史 stringify 成巨型字符串，同时降低中间历史变更被误判为 delta 的概率。
  const lastIndex = count - 1;
  const indexes = new Set([
    0,
    Math.floor(lastIndex * 0.25),
    Math.floor(lastIndex * 0.5),
    Math.floor(lastIndex * 0.75),
    lastIndex,
  ]);
  return [...indexes].map((index) => fingerprintValue(value[index]));
}

function fingerprintValue(value: unknown, depth = 0): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    return [
      "string",
      String(value.length),
      value.slice(0, FINGERPRINT_STRING_LIMIT),
      value.slice(-FINGERPRINT_STRING_LIMIT),
    ].join(":");
  }
  if (typeof value !== "object") {
    return `${typeof value}:${String(value)}`;
  }
  if (depth >= 3) {
    return Array.isArray(value) ? `array:${value.length}` : "object";
  }
  if (Array.isArray(value)) {
    return [
      "array",
      String(value.length),
      fingerprintValue(value[0], depth + 1),
      fingerprintValue(value[value.length - 1], depth + 1),
    ].join(":");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const sampledKeys = keys.slice(0, 12);
  return [
    "object",
    String(keys.length),
    ...sampledKeys.map((key) => `${key}=${fingerprintValue(record[key], depth + 1)}`),
  ].join(":");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
