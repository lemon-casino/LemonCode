import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { getLCodeDataRootDir } from "@lcode/services/node";
import type {
  CreateTempTextAttachmentRequest,
  CreateTempTextAttachmentResult,
} from "@lcode/shared";

const TEMP_TEXT_ATTACHMENT_DIR = "paste-attachments";
const MIME_TYPE = "text/plain" as const;

export async function createTempTextAttachment(
  payload: CreateTempTextAttachmentRequest,
): Promise<CreateTempTextAttachmentResult> {
  if (typeof payload.text !== "string" || payload.text.length === 0) {
    throw new Error("Temporary text attachment content is empty");
  }

  const now = new Date();
  const dateDir = [now.getFullYear(), pad(now.getMonth() + 1), pad(now.getDate())].join("-");
  const rootDir = join(getLCodeDataRootDir(), "tmp", TEMP_TEXT_ATTACHMENT_DIR, dateDir);
  await mkdir(rootDir, { recursive: true });

  const filename = buildTempTextAttachmentFilename(payload.filename);
  const localPath = join(rootDir, filename);
  const content = Buffer.from(payload.text, "utf8");
  await writeFile(localPath, content, { flag: "wx" });

  return {
    filename,
    localPath,
    mimeType: MIME_TYPE,
    sizeBytes: content.byteLength,
  };
}

function buildTempTextAttachmentFilename(filename: string | undefined): string {
  const rawBase = filename?.trim() || "pasted-text.txt";
  const normalized = rawBase.replaceAll("\0", "-").replace(/[\\/:]/gu, "-");
  const safeName = normalized.endsWith(".txt") ? normalized : `${normalized}.txt`;
  const suffix = randomUUID().slice(0, 8);
  const dotIndex = safeName.lastIndexOf(".");
  if (dotIndex <= 0) {
    return `${safeName}-${suffix}.txt`;
  }
  return `${safeName.slice(0, dotIndex)}-${suffix}${safeName.slice(dotIndex)}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
