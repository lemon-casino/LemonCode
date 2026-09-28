import type { ModelSelectionView } from "@lcode/provider";
import type { SessionConfigState } from "@lcode/shared/lcode-protocol-v4";
import { createComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

/** 副屏继承父 runtime 的生效模型；不能把主 Composer 未提交的草稿带进新 child。 */
export function resolveSelectionSideInheritedModel(
  config: SessionConfigState | null | undefined,
  view: ModelSelectionView | null,
) {
  if (!config) return null;
  return (
    createComposerSubmissionConfig(
      {
        mode: config.mode,
        modelSelection: {
          providerId: config.provider,
          modelId: config.model,
          options: { reasoningLevel: config.thought },
        },
      },
      view,
    )?.modelSelection ?? null
  );
}
