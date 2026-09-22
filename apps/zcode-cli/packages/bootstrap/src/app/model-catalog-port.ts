// ============================================================
// ModelCatalogPort 的宿主实现：Provider Registry → 工具层看得见的模型目录
// ============================================================
// 端口契约见 contracts/src/interfaces/model-catalog.port.ts。存在的理由只有一个：
// `CreateWorkflow` / `AmendWorkflow` 的 `subagent_model` 要把用户说的模型名解析成一次
// workflow run 的子代理选型，而 core 看不见 provider 注册表。本模块把「有哪些模型」这件宿主
// 事实递过去，解析本身留在 core 的纯函数里。
//
// 与 provider-registry-selection.ts 的 `listRegistryBackedModels` 是同一份注册表的**两张脸**：
// 那边产出 GUI picker 的 `ZCodeModelOption`（带 label / maxOutputTokens / 格式属性），这边产出
// 工具层要的窄条目。刻意不共用一个投影函数——两张脸的字段集与在场规则各自独立，硬要合并只会
// 让一次为 picker 做的改动悄悄改掉模型解析的判据。共用的是**默认档位那条规则**（见下）。

import type { ModelCatalogEntry, ModelCatalogPort } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

interface ModelCatalogPortDeps {
  /** 进程的 Provider Registry。**整个对象**存下来，绝不在这里 `getView()` 一次存成快照。 */
  registry: ProviderRegistryModelSource;
  /**
   * 会话**当前**的模型选择（`runtime.getSessionModelSelection()`）。与 registry 同理是函数而
   * 不是值：`current` 是每次列举那一刻的事实，用户可以在两次工具调用之间换主模型。
   */
  currentSelection: () => ModelSelection | undefined;
}

/**
 * 造 {@link ModelCatalogPort}。
 *
 * **`listModels()` 每次调用都现读 `registry.getView()`**，绝不缓存——这不是性能取舍，是
 * stale provider registry 的直接教训：子代理抱着父会话构造那一刻的
 * provider 适配器不放，用户中途改了 provider 之后，子代理仍在对着一个已经不存在的配置
 * 发请求。一份构造期冻结的目录会让 `subagent_model` 解析挑中一个此刻已被删掉的模型，而
 * 失败要等到子代理第一次开口才炸——离用户按下确认已经很远了。视图本身是内存对象，
 * 重读它不是 I/O。
 */
export function createModelCatalogPort(deps: ModelCatalogPortDeps): ModelCatalogPort {
  return {
    listModels(): ModelCatalogEntry[] {
      // 这一行就是上面那条纪律的全部实现。任何把它提到闭包外的「优化」都在重演同一问题。
      const view = deps.registry.getView();
      const current = deps.currentSelection();
      return view.providers.flatMap((provider) =>
        provider.models.map((model): ModelCatalogEntry => {
          const reasoning = model.config.optionSpecs.reasoningLevel;
          // 档位表**复制**而不是原样递出：注册表的 values 是 readonly 视图的一部分，
          // 端口契约给的是一个普通可读数组，让调用方拿到一份不会随注册表变动的副本。
          const reasoningLevels = [...reasoning.values];
          // 默认档位 = 最后一档，与 provider-registry-selection.ts 的 `toModelOption`
          // （GUI picker 的 `reasoning.defaultLevel`）**同一条规则**。两处给出不同的默认，
          // 就会出现「picker 里默认 high、`subagent_model` 不写档位时默认 low」这种只有用户
          // 会发现的偏差。没有档位的模型整个字段缺席（空数组 + 无默认）。
          const defaultReasoningLevel = reasoning.values.at(-1);
          const defaultSpeed = model.config.optionSpecs.speed?.values[0];
          const speeds = [...(model.config.optionSpecs.speed?.values ?? [])];
          const contextWindow = model.config.properties.contextWindow;
          // `providerName` 在注册表里是 `string | null | undefined`（config-service.ts 把空串
          // 归一成 `null`），而端口契约上是 `string | undefined`。三种「没名字」在这里合成
          // **一个**答案：键缺席。绝不放一个 `null` 或空串过去——它会原样印进 ListModels 的
          // 那一行，而读侧要的是「没取过名字就退回 providerId」。
          const providerLabel = provider.providerName?.trim();
          return {
            providerId: provider.providerId,
            modelId: model.modelId,
            // provider 的人类可读名；没取过就缺席（读侧退回 providerId），不在这里兜成
            // providerId——那会让「有没有取过名字」这件事在端口上消失。
            ...(providerLabel ? { providerLabel } : {}),
            reasoningLevels,
            ...(defaultReasoningLevel === undefined ? {} : { defaultReasoningLevel }),
            ...(defaultSpeed === undefined ? {} : { defaultSpeed }),
            speeds,
            ...(contextWindow === undefined ? {} : { contextWindow }),
            // 身份两段相等即当前选择；options 不是身份的一部分（与 workflow-actor-model.ts
            // 的 pin 比对同一条判据）。整张表至多一条为真。
            current:
              current !== undefined &&
              current.providerId === provider.providerId &&
              current.modelId === model.modelId,
            // `disabledReason` 刻意**恒缺席**：本宿主今天没有这条事实的来源。GUI 的模型列表
            // 走同一份注册表（listRegistryBackedModels → toModelOption），那条路也从不写这个
            // 字段；`registry.validateSelection()` 也不是来源——我们枚举的每一条都来自注册表
            // 视图本身，按构造必然校验通过。仓库里唯一产出 disabledReason 的地方在
            // packages/services 的桌面端 legacy 配置迁移里，够不到这份注册表。将来真有了
            // 「配了但不可用」的判据（缺密钥、被策略禁用），补在这里即可，端口契约不用动。
          };
        }),
      );
    },
  };
}
