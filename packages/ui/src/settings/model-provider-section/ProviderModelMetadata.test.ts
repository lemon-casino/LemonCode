import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsFormModel } from "@/lib/providerSettingsFormTypes.js";
import { ModelPropertiesConfig, type ModelConfigObject } from "@zcode/provider";
import {
  createProviderModelDraftValues,
  resolveProviderModelDraftCommit,
} from "./ProviderModelMetadata.js";
import { updateModelDraft } from "./ProviderModelDraftState.js";

function createConfig({
  supportsImage = true,
  supportsTextOutput = true,
  interactionProtocol,
}: {
  supportsImage?: boolean;
  supportsTextOutput?: boolean;
  interactionProtocol?: "native-tool-calls" | "ui-tars-text-actions";
} = {}): ModelConfigObject {
  return {
    enabled: true,
    properties: {
      requiresMfjsToolSchema: false,
      contextWindow: 128_000,
      inputFormat: {
        supportsText: true,
        supportsImage,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: supportsTextOutput },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
      ...(interactionProtocol === undefined ? {} : { interactionProtocol }),
    },
    optionSpecs: {
      reasoningLevel: { values: ["medium"], map: "{}" },
      maxOutputTokens: { max: 8_192, map: "{}" },
    },
  };
}

function createModel(config = createConfig()): ProviderSettingsFormModel {
  return {
    kind: "candidate",
    modelId: "vision-model",
    builtin: false,
    inheritedConfig: config,
    personalConfig: {},
    useRecommendedConfig: true,
    config,
    hasPersonalConfig: false,
    executable: true,
    selectable: true,
  };
}

test("旧模型配置显示原生工具协议但保存时不物化默认字段", () => {
  const model = createModel();
  const draft = createProviderModelDraftValues(model);

  assert.equal(draft.interactionProtocolValue, "native-tool-calls");
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft });

  assert.equal(result.status, "commit");
  if (result.status !== "commit") return;
  assert.equal(result.model.personalConfig.properties?.interactionProtocol, undefined);
  assert.equal(result.model.config.properties?.interactionProtocol, undefined);
});

test("显式选择 UI-TARS 文本动作写入稀疏个人配置", () => {
  const model = createModel();
  const draft = updateModelDraft(
    createProviderModelDraftValues(model),
    { interactionProtocolValue: "ui-tars-text-actions" },
    model,
  );

  assert.ok(draft.overriddenFieldsValue?.includes("interactionProtocolValue"));
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft });

  assert.equal(result.status, "commit");
  if (result.status !== "commit") return;
  assert.equal(result.model.personalConfig.properties?.interactionProtocol, "ui-tars-text-actions");
  assert.equal(result.model.config.properties?.interactionProtocol, "ui-tars-text-actions");
});

test("UI-TARS 文本动作在模型不支持图片输入时拒绝提交", () => {
  const model = createModel(createConfig({ supportsImage: false }));
  const draft = updateModelDraft(
    createProviderModelDraftValues(model),
    { interactionProtocolValue: "ui-tars-text-actions" },
    model,
  );

  assert.deepEqual(resolveProviderModelDraftCommit({ currentModel: model, draft }), {
    status: "invalid",
    field: "interactionProtocol",
  });
});

test("UI-TARS 文本动作在模型不支持文本输出时拒绝提交", () => {
  const model = createModel(createConfig({ supportsTextOutput: false }));
  const draft = updateModelDraft(
    createProviderModelDraftValues(model),
    { interactionProtocolValue: "ui-tars-text-actions" },
    model,
  );

  assert.deepEqual(resolveProviderModelDraftCommit({ currentModel: model, draft }), {
    status: "invalid",
    field: "interactionProtocol",
  });
});

test("provider 完整配置拒绝 UI-TARS 缺少图片输入或文本输出能力", () => {
  const validate = (supportsImage: boolean, supportsTextOutput: boolean) =>
    new ModelPropertiesConfig({
      ...createConfig({ supportsImage, supportsTextOutput }).properties,
      interactionProtocol: "ui-tars-text-actions",
    }).validateComplete();

  assert.deepEqual(validate(true, true), []);
  assert.match(validate(false, true)[0]?.message ?? "", /图片输入/u);
  assert.match(validate(true, false)[0]?.message ?? "", /文本输出/u);
});

test("推荐配置为 UI-TARS 时可用显式 native 覆盖", () => {
  const model = createModel(createConfig({ interactionProtocol: "ui-tars-text-actions" }));
  const draft = updateModelDraft(
    createProviderModelDraftValues(model),
    { interactionProtocolValue: "native-tool-calls" },
    model,
  );
  const result = resolveProviderModelDraftCommit({ currentModel: model, draft });

  assert.equal(result.status, "commit");
  if (result.status !== "commit") return;
  assert.equal(result.model.personalConfig.properties?.interactionProtocol, "native-tool-calls");
  assert.equal(result.model.config.properties?.interactionProtocol, "native-tool-calls");
});
