import { z } from "zod";

/** 仅承载已提交内容引用与展示元信息；内容本体不进入 command/topic frame。 */
export const attachmentRefSchema = z
  .object({
    ref: z.string(),
    fileName: z.string(),
    mime: z.string(),
    bytes: z.number(),
    previewRef: z.string().optional(),
  })
  .strict();

export const workflowImageAttachmentRefSchema = attachmentRefSchema.refine(
  (ref) =>
    ref.mime.toLowerCase().startsWith("image/") &&
    ref.mime.length <= 128 &&
    ref.fileName.length > 0 &&
    ref.fileName.length <= 255 &&
    ref.ref.length > 0 &&
    ref.ref.length <= 4096 &&
    Number.isSafeInteger(ref.bytes) &&
    ref.bytes >= 0,
);

export type AttachmentRef = z.infer<typeof attachmentRefSchema>;
