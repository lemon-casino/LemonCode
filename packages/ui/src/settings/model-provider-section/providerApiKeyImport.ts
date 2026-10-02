import type { ProviderApiKey } from "@lcode/provider";
import { nanoid } from "nanoid/non-secure";

export function createProviderApiKeyId(): string {
  // 行身份不承载凭据；复用已有 nanoid，避免局域网 HTTP 下 randomUUID 不可用阻断新增/导入。
  return `key-${nanoid()}`;
}

export const MAX_API_KEY_IMPORT_BYTES = 128 * 1024 * 1024;

type ImportErrorCode =
  | "empty"
  | "invalidJson"
  | "invalidFormat"
  | "tooLarge"
  | "readFailed"
  | "workerFailed";
export type ImportedProviderApiKey = Omit<ProviderApiKey, "id">;

export class ProviderApiKeyImportError extends Error {
  constructor(public readonly code: ImportErrorCode) {
    super(code);
  }
}

const KEY_FIELDS = ["apiKey", "api_key", "key", "token"];
const KEY_LIST_FIELDS = ["apiKeys", "api_keys", "keys"];
const WRAPPER_FIELDS = ["data", "items", "access", "config"];
const TEXT_SEPARATORS = /[\s,;，；、|]+/u;
// 文本/JSON 文件中的控制字符表明内容不可作为凭据，显式拦截二进制与解码失败。
// eslint-disable-next-line no-control-regex
const BINARY_CHARACTERS = /[\u0000-\u0008\u000e-\u001f\u007f\ufffd]/u;

function readJsonKeys(value: unknown, depth = 0): ImportedProviderApiKey[] {
  if (depth > 20) throw new ProviderApiKeyImportError("invalidFormat");
  if (typeof value === "string") {
    const apiKey = value.trim();
    if (!apiKey) return [];
    if (/\s/u.test(apiKey) || BINARY_CHARACTERS.test(apiKey)) {
      throw new ProviderApiKeyImportError("invalidFormat");
    }
    return [{ apiKey, enabled: true }];
  }
  if (Array.isArray(value)) return value.flatMap((item) => readJsonKeys(item, depth + 1));
  if (!value || typeof value !== "object") throw new ProviderApiKeyImportError("invalidFormat");

  const record = value as Record<string, unknown>;
  // Provider Access 导出同时包含主 Key 与列表；列表是完整事实，不能被兼容单 Key 截断。
  const keyList = KEY_LIST_FIELDS.find((field) => Object.hasOwn(record, field));
  if (keyList) return readJsonKeys(record[keyList], depth + 1);
  const keyField = KEY_FIELDS.find((field) => Object.hasOwn(record, field));
  if (keyField) {
    const keyValue = record[keyField];
    if (typeof keyValue !== "string") throw new ProviderApiKeyImportError("invalidFormat");
    if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
      throw new ProviderApiKeyImportError("invalidFormat");
    }
    const label = record.label ?? record.name;
    if (label !== undefined && typeof label !== "string") {
      throw new ProviderApiKeyImportError("invalidFormat");
    }
    return readJsonKeys(keyValue, depth + 1).map((key) => ({
      ...key,
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      enabled: record.enabled !== false,
    }));
  }
  const wrapper = WRAPPER_FIELDS.find((field) => Object.hasOwn(record, field));
  if (wrapper) return readJsonKeys(record[wrapper], depth + 1);
  throw new ProviderApiKeyImportError("invalidFormat");
}

export function parseProviderApiKeyImport(source: string): ImportedProviderApiKey[] {
  if (new TextEncoder().encode(source).byteLength > MAX_API_KEY_IMPORT_BYTES) {
    throw new ProviderApiKeyImportError("tooLarge");
  }
  const text = source.trim();
  if (BINARY_CHARACTERS.test(text)) throw new ProviderApiKeyImportError("invalidFormat");
  let keys: ImportedProviderApiKey[];
  if (text.startsWith("[") || text.startsWith("{") || text.startsWith('"')) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      // JSON 原始异常可能包含密钥片段；只向界面传递固定错误码，且不把损坏 JSON 当文本导入。
      throw new ProviderApiKeyImportError("invalidJson");
    }
    keys = readJsonKeys(value);
  } else {
    keys = text.split(TEXT_SEPARATORS).flatMap((item) => {
      const apiKey = item.replace(/^(["'`])(.*)\1$/u, "$2").trim();
      return apiKey ? [{ apiKey, enabled: true }] : [];
    });
  }
  if (keys.length === 0) throw new ProviderApiKeyImportError("empty");
  return keys;
}

export async function readProviderApiKeyImportFiles(
  files: readonly Pick<File, "size" | "text">[],
): Promise<ImportedProviderApiKey[]> {
  if (files.length === 0) throw new ProviderApiKeyImportError("empty");
  if (files.reduce((total, file) => total + file.size, 0) > MAX_API_KEY_IMPORT_BYTES) {
    throw new ProviderApiKeyImportError("tooLarge");
  }
  let contents: string[];
  try {
    contents = await Promise.all(files.map((file) => file.text()));
  } catch {
    throw new ProviderApiKeyImportError("readFailed");
  }
  // 所有文件解析成功后才返回，避免某个文件失败时已经写入前面的部分 Key。
  return contents.flatMap(parseProviderApiKeyImport);
}

export function mergeProviderApiKeyImport(
  draft: readonly ProviderApiKey[],
  imported: readonly ImportedProviderApiKey[],
  createId: () => string = createProviderApiKeyId,
): { draft: ProviderApiKey[]; added: number; duplicates: number } {
  const seen = new Set(draft.map((key) => key.apiKey.trim()).filter(Boolean));
  const next = [...draft];
  let added = 0;
  let duplicates = 0;
  for (const key of imported) {
    const apiKey = key.apiKey.trim();
    if (!apiKey) continue;
    if (seen.has(apiKey)) {
      duplicates += 1;
      continue;
    }
    seen.add(apiKey);
    next.push({
      id: createId(),
      apiKey,
      label: key.label || `API Key ${next.length + 1}`,
      enabled: key.enabled !== false,
    });
    added += 1;
  }
  return { draft: next, added, duplicates };
}
