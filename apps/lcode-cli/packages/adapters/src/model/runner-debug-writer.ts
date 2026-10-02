import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { sanitizeModelIODebugRecord } from "./runner-debug-redaction.js";
import { stringMetadata } from "./runner-record.js";
import {
  buildModelIOCompactionState,
  compactModelIORecord,
  prepareModelIORecordForWrite,
  type ModelIOCompactionState,
} from "./runner-debug-compaction.js";

// 生产环境 rollout 目录最多保留的 model-io 会话文件数。超出删最旧。
const MAX_ROLLOUT_FILES = 3;
// 生产环境单个 session 的 model-io 文件硬上限。诊断日志不能因为无限增长影响 agent 主流程。
const MAX_ROLLOUT_SESSION_BYTES = 64 * 1024 * 1024;
// 开发态保留更多上下文，但仍避免单个 debug 文件无限膨胀。
const MAX_DEBUG_SESSION_BYTES = 256 * 1024 * 1024;
// 缓存缺失或文件超限后写 baseline 时，仅保留最近上下文，避免长 session 重启后再次写出巨型记录。
const MAX_ROLLOUT_BASELINE_MESSAGES = 64;
const MAX_DEBUG_BASELINE_MESSAGES = 256;

// 每个会话文件只有此写入边界拥有 compaction 状态；纯投影 helper 不保存第二份缓存。
const modelIOCompactionStates = new Map<string, ModelIOCompactionState>();

export function writeModelIODebugRecord(
  record: Record<string, unknown>,
  debugDir?: string,
  isDev?: boolean,
  modelIoFullRetentionEnabled = false,
): void {
  try {
    // model-I/O 诊断直接持久化 AI SDK 的 request/response headers，
    // 闲时 Provider 的 JWT、Coding Plan Key 与 ticket 因此会写入按 session 命名的文件。
    // 在统一落盘边界复用网络遥测脱敏，保证 generate/stream 及后续调用方都不会漏掉。
    const sanitizedRecord = sanitizeModelIODebugRecord(record);
    const development = isDev ?? false;
    const dir = debugDir ?? getModelIOBaseDir(isDev ?? false);
    mkdirSync(dir, { recursive: true });
    const sessionSegment =
      sanitizeFileSegment(stringMetadata(sanitizedRecord.sessionId)) || "no-session";
    const fileName = `model-io-${sessionSegment}.jsonl`;
    const filePath = join(dir, fileName);
    const fileExists = existsSync(filePath);
    if (modelIoFullRetentionEnabled) {
      // 全量保留仍经过统一脱敏边界，但跳过轮转、限额重置、生产裁剪和上下文压缩。
      // 这是用户显式选择的诊断模式；更新 compaction state 使关闭后下一次 bounded 写入可平滑续接。
      appendFileSync(filePath, `${stringifyDebugRecord(sanitizedRecord)}\n`, "utf8");
      modelIOCompactionStates.set(filePath, buildModelIOCompactionState(sanitizedRecord));
      return;
    }
    // 生产态(rollout)做容量上限,避免长期运行把磁盘刷爆;开发态(debug)也保留更高的单文件上限。
    // 同一 session 之前每次模型请求都会新建一个完整上下文文件，形成三角形重复；
    // 现在改为一个 session 一个 JSONL 文件，新请求 append 到同文件，只有新 session 才参与淘汰。
    if (!development && !fileExists) {
      rotateModelIOFiles(dir, MAX_ROLLOUT_FILES - 1);
    }
    const existingBytes = fileExists ? readFileSize(filePath) : 0;
    const maxSessionBytes = development ? MAX_DEBUG_SESSION_BYTES : MAX_ROLLOUT_SESSION_BYTES;
    const resetForSizeLimit = existingBytes >= maxSessionBytes;
    const preparedRecord = prepareModelIORecordForWrite(sanitizedRecord, development);
    const previousState =
      fileExists && !resetForSizeLimit ? modelIOCompactionStates.get(filePath) : undefined;
    const compacted = compactModelIORecord(preparedRecord, previousState, {
      maxBaselineMessages: development
        ? MAX_DEBUG_BASELINE_MESSAGES
        : MAX_ROLLOUT_BASELINE_MESSAGES,
      preserveFullBodyMessages: Boolean(preparedRecord.error),
    });
    const recordToWrite = resetForSizeLimit
      ? {
          ...compacted,
          modelIOReset: {
            maxFileBytes: maxSessionBytes,
            previousFileBytes: existingBytes,
            reason: "session_file_size_limit",
          },
        }
      : compacted;
    const line = `${stringifyDebugRecord(recordToWrite)}\n`;
    if (resetForSizeLimit) {
      // 每次 append 前同步读取并 expand 整个历史 JSONL 的话，长 session 的 rollout
      // 文件达到 GB 级时会在 UTF-8 转换/V8 字符串分配阶段 native crash。超限时直接重置为
      // 当前 bounded baseline，保证诊断日志不会威胁 agent 主流程。
      writeFileSync(filePath, line, "utf8");
    } else {
      appendFileSync(filePath, line, "utf8");
    }
    modelIOCompactionStates.set(filePath, buildModelIOCompactionState(preparedRecord));
  } catch {
    // Model I/O debug logging must never affect the model request path.
  }
}

// 保证目录下 model-io-*.jsonl 文件数不超过 maxFiles(为本次新 session 文件留位时传 maxFiles-1)。
function rotateModelIOFiles(dir: string, maxFiles: number): void {
  let files: string[];
  try {
    files = readdirSync(dir).filter(
      (name) => name.startsWith("model-io-") && name.endsWith(".jsonl"),
    );
  } catch {
    return; // 目录刚创建/读取失败,无需淘汰
  }

  let removeCount = files.length - maxFiles;
  if (removeCount <= 0) {
    return;
  }

  const oldestFirst = files
    .map((name) => {
      try {
        return { name, mtimeMs: statSync(join(dir, name)).mtimeMs };
      } catch {
        return { name, mtimeMs: 0 };
      }
    })
    .sort((left, right) => left.mtimeMs - right.mtimeMs)
    .map((entry) => entry.name);
  for (const name of oldestFirst) {
    if (removeCount <= 0) break;
    const filePath = join(dir, name);
    try {
      rmSync(filePath, { force: true });
      modelIOCompactionStates.delete(filePath);
      removeCount -= 1;
    } catch {
      // 单个文件删除失败不阻断写入
    }
  }
}

// 仅保留文件名安全字符,其余折叠为 -,并限长避免触达 Windows 路径长度上限。
function sanitizeFileSegment(value?: string): string {
  if (!value) {
    return "";
  }
  return value
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

// storage profile 回滚删除了自定义 CLI 根模块，遗留 import 会让 adapters 无法构建。
// 这里保持历史语义：开发态写 ~/.lcode/cli/debug，生产态写 ~/.lcode/cli/rollout。
function getModelIOBaseDir(isDev: boolean): string {
  return join(homedir(), ".lcode", "cli", isDev ? "debug" : "rollout");
}

function stringifyDebugRecord(record: Record<string, unknown>): string {
  return JSON.stringify(record);
}

function readFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}
