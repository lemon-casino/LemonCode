import { z } from "zod";

/**
 * Onboarding 完成记录（三步向导：职业 / 模式 / 偏好）。
 *
 * 设计约束：
 * - 独立本地 JSON（~/.lcode/v2/onboarding-record.json），不混入 AppSettings；
 * - 以 deviceMid 为设备锚点，entries 支持多个 userId（多人登录）与 null（apikey/未登录）；
 * - uploadState 预留后续上传服务器：pending → uploaded；
 * - 跳过是显式答案：某页被跳过时该字段记 null，与"明确选择了值"区分。
 */

/** occupation 用非空字符串而非枚举：职业列表会演进，旧记录不能因枚举收窄而校验失败。 */
export const onboardingOccupationSchema = z.string().min(1).nullable();

export const onboardingInterfaceModeSchema = z.enum(["coding", "office"]).nullable();

export const onboardingRecordEntrySchema = z.object({
  userId: z.string().min(1).nullable(),
  occupation: onboardingOccupationSchema,
  interfaceMode: onboardingInterfaceModeSchema,
  memoryEnabled: z.boolean().nullable(),
  proactiveSuggestionsEnabled: z.boolean().nullable(),
  completedAt: z.string().min(1),
  uploadState: z.literal("pending"),
});

export const onboardingRecordFileSchema = z.object({
  version: z.literal(1),
  deviceMid: z.string().min(1),
  entries: z.array(onboardingRecordEntrySchema),
});

export type OnboardingRecordEntry = z.infer<typeof onboardingRecordEntrySchema>;

/** appendRecord 的入参：userId 由服务端（host）补全，调用方不传。 */
export type OnboardingRecordEntryInput = Omit<OnboardingRecordEntry, "userId" | "uploadState">;

export type OnboardingRecordFile = z.infer<typeof onboardingRecordFileSchema>;
