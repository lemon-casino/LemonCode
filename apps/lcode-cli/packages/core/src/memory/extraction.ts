import {
  MEMORY_HISTORY_TOOL_NAME,
  MEMORY_REVIEW_APPLY_TOOL_NAME,
  MEMORY_REVIEW_TOOL_NAME,
  type MessageId,
  type MessageWithParts,
  type ToolPart,
} from "@lcode/contracts";
import { resolveContainedMemoryFilePath } from "./memory-file-path.js";
import { formatMemoryManifest } from "./recall/manifest.js";
import type { MemoryManifestEntry } from "./recall/types.js";

const MINIMUM_USER_WORDS = 3;

type MemoryExtractionExecutionStatus = "success" | "no-op" | "error" | "aborted";

export interface MemoryExtractionSnapshot {
  boundaryMessageId: MessageId;
  durableMessages: readonly MessageWithParts[];
  memoryRoot: string;
  workingDirectory: string;
  workspaceRoot: string;
}

type MemoryExtractionDecision =
  | { decision: "run"; messageCount: number }
  | {
      decision: "skip";
      messageCount: number;
      reason: "direct-memory-write" | "no-user-prose";
    };

interface MemoryExtractionExecutionInput {
  abortSignal: AbortSignal;
  messageCount: number;
  snapshot: MemoryExtractionSnapshot;
}

export interface MemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
> {
  drain(): Promise<void>;
  getCursor(): MessageId | undefined;
  hasPendingWork(): boolean;
  schedule(snapshot: TSnapshot | Promise<TSnapshot>): void;
  shutdown(): void;
}

export function buildMemoryExtractionPrompt(input: {
  manifest: readonly MemoryManifestEntry[];
  messageCount: number;
}): string {
  const existingMemories =
    input.manifest.length > 0
      ? `\n\n## Existing memory files\n\n${formatMemoryManifest(input.manifest)}\n\nCheck this list before writing \u2014 update an existing file rather than creating a duplicate.`
      : "";

  return [
    `You are now acting as the memory extraction subagent. Analyze the most recent ~${input.messageCount} messages above and use them to update your persistent memory systems.`,
    "",
    "Available tools: Read, Grep, Glob, read-only Bash (ls/find/cat/stat/wc/head/tail and similar), and Edit/Write for Markdown paths inside the memory directory only. All other tools \u2014 MCP, Agent, write-capable Bash, deletion commands, etc \u2014 will be denied.",
    "",
    "You have a limited turn budget. Read each existing file before changing it. Tools in each response execute sequentially in declaration order; place each Read before its dependent Write/Edit and keep writes sequential, especially for the same file.",
    "",
    `You MUST only use content from the last ~${input.messageCount} messages to update your persistent memories. Do not waste any turns attempting to investigate or verify that content further \u2014 no grepping source files, no reading code to confirm a pattern exists, no git commands.${existingMemories}`,
    "",
    "If nothing is worth saving, output only 'Nothing to save.' Do not explain why.",
    "",
    "If the user explicitly asks you to remember something, save it immediately as whichever type fits best. Automatic deletion is not supported in this version. If they ask you to forget something, leave it unchanged for the user to remove in an external editor; do not claim it was deleted.",
    "",
    "Apply the memory types, what-not-to-save criteria, and frontmatter format from the Memory section of your system prompt \u2014 it is already in your context above.",
  ].join("\n");
}

export function isMemoryReviewOperation(toolName: string, input: unknown): boolean {
  if (toolName === MEMORY_REVIEW_APPLY_TOOL_NAME) return true;
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const action = (input as Record<string, unknown>).action;
  return (
    (toolName === MEMORY_REVIEW_TOOL_NAME &&
      (action === "create" || action === "read" || action === "list")) ||
    (toolName === MEMORY_HISTORY_TOOL_NAME && action === "undo")
  );
}

export function messagesAfterLastMemoryReviewTurn(
  messages: readonly MessageWithParts[],
): readonly MessageWithParts[] {
  const lastReviewIndex = messages.findLastIndex((message) =>
    message.parts.some(
      (part) => part.type === "tool" && isMemoryReviewOperation(part.tool, part.state.input),
    ),
  );
  if (lastReviewIndex < 0) return messages;
  // 不能只移走 ToolPart：同轮用户输入、通知和 assistant 正文都可能转述未采用的提案。
  // 以持久真实 user 边界裁后缀；每个快照重算，冷恢复/旧 cursor 也不会重新学习该轮。
  const nextUserIndex = messages.findIndex(
    (message, index) => index > lastReviewIndex && isRealUserReviewBoundary(message),
  );
  // compact 摘要是旧上下文的派生文本，可能重述提案；不能经 hydrator 再把它带回提取请求。
  return nextUserIndex < 0
    ? []
    : messages
        .slice(nextUserIndex)
        .filter(
          (message) =>
            !message.info.summary &&
            message.info.semantics?.kind !== "compact_summary" &&
            !message.parts.some((part) => part.type === "compaction"),
        );
}

function isRealUserReviewBoundary(message: MessageWithParts): boolean {
  return (
    isNonMetaUserMessage(message) &&
    !message.info.summary &&
    (message.info.semantics?.origin === undefined ||
      message.info.semantics.origin === "real_user") &&
    (message.info.anchor?.origin === undefined || message.info.anchor.origin === "realUser") &&
    message.parts.some(
      (part) =>
        part.type === "file" ||
        (part.type === "text" && part.synthetic !== true && part.ignored !== true),
    )
  );
}

function evaluateMemoryExtraction(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): MemoryExtractionDecision {
  const messageCount = countMessagesAfterCursor(snapshot.durableMessages, cursor);

  if (containsDirectMemoryWrite(snapshot, cursor)) {
    return { decision: "skip", messageCount, reason: "direct-memory-write" };
  }

  if (!containsEligibleUserProse(snapshot.durableMessages, cursor)) {
    return { decision: "skip", messageCount, reason: "no-user-prose" };
  }

  return { decision: "run", messageCount };
}

export function createMemoryExtractionScheduler<
  TSnapshot extends MemoryExtractionSnapshot = MemoryExtractionSnapshot,
>(
  execute: (
    input: Omit<MemoryExtractionExecutionInput, "snapshot"> & { snapshot: TSnapshot },
  ) => Promise<MemoryExtractionExecutionStatus>,
): MemoryExtractionScheduler<TSnapshot> {
  let cursor: MessageId | undefined;
  let latestPending: Promise<SnapshotAcquisition<TSnapshot>> | undefined;
  let running: Promise<void> | undefined;
  let shuttingDown = false;
  const shutdownController = new AbortController();

  const processSnapshot = async (snapshot: TSnapshot): Promise<void> => {
    const durableMessages = messagesAfterLastMemoryReviewTurn(snapshot.durableMessages);
    const safeSnapshot =
      durableMessages === snapshot.durableMessages ? snapshot : { ...snapshot, durableMessages };
    const decision = evaluateMemoryExtraction(safeSnapshot, cursor);
    const snapshotEnd = snapshot.boundaryMessageId;

    if (decision.decision === "skip") {
      if (snapshotEnd) cursor = snapshotEnd;
      return;
    }

    let status: MemoryExtractionExecutionStatus;
    try {
      status = await execute({
        abortSignal: shutdownController.signal,
        messageCount: decision.messageCount,
        snapshot: safeSnapshot,
      });
    } catch {
      return;
    }

    if (!shuttingDown && (status === "success" || status === "no-op") && snapshotEnd) {
      cursor = snapshotEnd;
    }
  };

  const run = async (first: Promise<SnapshotAcquisition<TSnapshot>>): Promise<void> => {
    try {
      let current: Promise<SnapshotAcquisition<TSnapshot>> | undefined = first;
      while (current && !shuttingDown) {
        const acquisition = await waitForSnapshotAcquisitionOrShutdown(
          current,
          shutdownController.signal,
        );
        if (acquisition.status === "shutdown" || shuttingDown) break;
        if (acquisition.status === "acquired") {
          try {
            await processSnapshot(acquisition.snapshot);
          } catch {
            // 本次 error 不推进 cursor；latest pending 仍按既有 coalescing 语义继续。
          }
        }
        current = shuttingDown ? undefined : latestPending;
        latestPending = undefined;
      }
    } finally {
      if (shuttingDown) latestPending = undefined;
      running = undefined;
    }
  };

  return {
    async drain() {
      while (running) {
        await running;
      }
    },
    getCursor() {
      return cursor;
    },
    hasPendingWork() {
      return running !== undefined || latestPending !== undefined;
    },
    schedule(snapshot) {
      if (shuttingDown) return;
      const acquisition = acquireSnapshot(snapshot);
      if (running) {
        latestPending = acquisition;
        return;
      }

      running = run(acquisition);
    },
    shutdown() {
      if (shuttingDown) return;
      // LCode 关闭单个 session 后进程仍继续运行；旧 scheduler 只让调用方
      // 放弃等待，running/pending Extraction 仍可能继续请求模型和写 Memory。
      shuttingDown = true;
      latestPending = undefined;
      shutdownController.abort();
    },
  };
}

type SnapshotAcquisition<TSnapshot> =
  | { status: "acquired"; snapshot: TSnapshot }
  | { status: "error" };

type SnapshotAcquisitionWait<TSnapshot> = SnapshotAcquisition<TSnapshot> | { status: "shutdown" };

function acquireSnapshot<TSnapshot>(
  snapshot: TSnapshot | Promise<TSnapshot>,
): Promise<SnapshotAcquisition<TSnapshot>> {
  return Promise.resolve(snapshot).then(
    (value) => ({ status: "acquired", snapshot: value }),
    () => ({ status: "error" }),
  );
}

function waitForSnapshotAcquisitionOrShutdown<TSnapshot>(
  acquisition: Promise<SnapshotAcquisition<TSnapshot>>,
  signal: AbortSignal,
): Promise<SnapshotAcquisitionWait<TSnapshot>> {
  if (signal.aborted) return Promise.resolve({ status: "shutdown" });

  return new Promise((resolve) => {
    const onAbort = (): void => {
      cleanup();
      resolve({ status: "shutdown" });
    };
    const cleanup = (): void => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    void acquisition.then((result) => {
      cleanup();
      resolve(result);
    });
  });
}

function countMessagesAfterCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): number {
  if (!cursor) return messages.length;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? messages.length : messages.length - cursorIndex - 1;
}

function containsDirectMemoryWrite(
  snapshot: MemoryExtractionSnapshot,
  cursor: MessageId | undefined,
): boolean {
  const messages = messagesAfterFoundCursor(snapshot.durableMessages, cursor);
  if (!messages) return false;

  for (const message of messages) {
    if (message.info.role !== "assistant") continue;
    for (const part of message.parts) {
      // 失败或尚未完成的 Write/Edit 没有保存记忆，不能因此跳过提取并推进 cursor。
      if (!isMemoryMutationToolPart(part) || part.state.status !== "completed") continue;
      const filePath = part.state.input.file_path;
      if (typeof filePath !== "string" || filePath.length === 0) continue;
      if (
        resolveContainedMemoryFilePath({
          filePath,
          rootDir: snapshot.memoryRoot,
          workingDirectory: snapshot.workingDirectory,
          workspaceRoot: snapshot.workspaceRoot,
        })
      ) {
        return true;
      }
    }
  }

  return false;
}

function containsEligibleUserProse(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): boolean {
  const messagesAfterCursor = messagesAfterFoundCursor(messages, cursor) ?? messages;
  for (const message of messagesAfterCursor) {
    if (!isNonMetaUserMessage(message)) continue;
    for (const part of message.parts) {
      if (
        part.type === "text" &&
        part.ignored !== true &&
        part.synthetic !== true &&
        countWords(part.text) >= MINIMUM_USER_WORDS
      ) {
        return true;
      }
    }
  }
  return false;
}

function messagesAfterFoundCursor(
  messages: readonly MessageWithParts[],
  cursor: MessageId | undefined,
): readonly MessageWithParts[] | undefined {
  if (!cursor) return messages;
  const cursorIndex = messages.findIndex((message) => message.info.id === cursor);
  return cursorIndex < 0 ? undefined : messages.slice(cursorIndex + 1);
}

function isNonMetaUserMessage(message: MessageWithParts): boolean {
  return (
    message.info.role === "user" &&
    message.info.synthetic !== true &&
    message.info.visibility !== "model-only"
  );
}

function isMemoryMutationToolPart(part: MessageWithParts["parts"][number]): part is ToolPart {
  return part.type === "tool" && (part.tool === "Write" || part.tool === "Edit");
}

function countWords(text: string): number {
  const hanCount = Array.from(text.matchAll(/\p{Script=Han}/gu)).length;
  // 旧逻辑只按空白切词，中文整句会被当成一个词而永远无法进入 extraction。
  // 先移除已逐字计数的汉字，再保留英文/数字“每个空白段一个词”的原有准入语义。
  const nonHanWordCount = text
    .replace(/\p{Script=Han}/gu, " ")
    .split(/\s+/u)
    .filter((segment) => /[\p{L}\p{N}]/u.test(segment)).length;
  return hanCount + nonHanWordCount;
}
