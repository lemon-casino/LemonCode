// ============================================================
// Model Catalog Port - 宿主已配置模型的只读快照边界
// ============================================================
// 存在的理由只有一个：
// 工具层要把用户说的模型名（"GLM-5.3-Flash"）解析成一次 workflow run 的子代理选型，而 core
// 看不见 provider 注册表。端口把「有哪些模型」这件宿主事实递进来，解析本身留在 core
// （纯函数，无 I/O）。
//
// 刻意**同步、无 I/O**：调用点在 `resolveInput` 与 `ListModels` 的 handler 里，两处都不该
// 为了列一张表去等网络；宿主侧本来就只是读一份内存里的注册表视图。

/** 目录里的一个模型条目（一条 provider × model 的组合）。 */
export interface ModelCatalogEntry {
  providerId: string;
  modelId: string;
  /** provider 的人类可读名；注册表没给就缺席（读侧退回 `providerId`）。 */
  providerLabel?: string;
  /** 该模型支持的推理档位（`$level` 的合法取值）。没有档位的模型是**空数组**，不是缺席。 */
  reasoningLevels: string[];
  /** 注册表的默认档位；`reasoningLevels` 为空时缺席。 */
  defaultReasoningLevel?: string;
  /** 主动指定模型时使用的默认速度；旧配置没有速度声明时缺席。 */
  defaultSpeed?: string;
  /** 可用速度；用于 GUI 设置的结构化选择预检。 */
  speeds?: string[];
  contextWindow?: number;
  /** 本条目是否就是会话当前的选择（provider + model 同一）。整张表至多一条为真。 */
  current: boolean;
  /** 不可选用的理由（未配置密钥、被策略禁用等）；可选用即缺席。 */
  disabledReason?: string;
}

export interface ModelCatalogPort {
  /**
   * 列出此刻可选的模型。
   *
   * **每次调用都必须现读注册表的活视图**，绝不返回构造期冻结的拷贝：provider 可以在会话
   * 中途被增删改（stale provider registry 的教训就是子代理抱着父会话构造时的
   * 那一份适配器不放）。一份过期的目录会让解析挑中一个已经不存在的模型，而失败要到子代理
   * 第一次开口时才炸——离用户按下确认已经很远了。
   */
  listModels(): ModelCatalogEntry[];
}
