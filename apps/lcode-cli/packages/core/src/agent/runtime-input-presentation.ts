import { parseRuntimeInputPresentation } from "@lcode/contracts";
import type { RuntimeMessageMetadata } from "./message-history.js";

/** 新标记决定真实输入身份，不能让 coordinator 继承 guide 的 real_user。 */
export function runtimeInputMetadata(value: unknown): RuntimeMessageMetadata | undefined {
  const inputPresentation = parseRuntimeInputPresentation(value);
  if (!inputPresentation) return undefined;
  return {
    source: inputPresentation === "user_steer" ? "real_user" : "legacy_synthetic",
    inputPresentation,
  };
}
