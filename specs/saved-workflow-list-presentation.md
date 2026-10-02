# 已保存工作流模板：列表、错误与协议边界

## 产品规则

1. 已保存的工作流定义是经 `SaveWorkflow` 保存的可复用模板，不是运行记录或 `.lcode/workflow-drafts` 草稿。创建、执行或执行成功均不自动保存模板；本次不迁移草稿、不创建模板，也不改变保存审批。
2. `ListSavedWorkflows` 聊天卡使用“工作流模板”表述，避免被理解成“刚刚保存成功”。正常查询同时覆盖本项目和全局目录，真实空结果明确说明“没有可复用模板，不代表没有运行记录”。聊天卡是该次工具结果的历史截面，不作为当前目录的实时列表。
3. 聊天卡区分进行中、失败、真实空列表、只有无效文件、正常列表与被截断列表。解析失败不转成空列表；legacy JSON 的非法条目不能被全部静默过滤成零条。只有无效文件时主摘要提示文件无法读取，展开后展示原因，不声称未保存过模板。
4. `truncated: true` 明确提示只展示部分模板或说明；计数只描述实际展示条数，不冒充模板总数。保留已支持的 scope、参数名、描述与路径。
5. 模板管理页只有当前请求已结束、成功且合法/无效文件均为零时才属于空列表。初次失败显示错误而不是空态；重新加载时显示加载状态，重试成功后清除错误。已有列表刷新失败时保留已读内容并显示错误，不能让列表盖住错误。
6. 一个 workspace 的重叠刷新只接纳最新请求；早发晚到的空结果或错误不得覆盖新的成功列表。复用已有 store 的 in-flight 请求身份，不新增状态所有者或时间兜底。项目身份继续使用 `workspaceIdentity?.trim() || workspacePath`，不改变全局/项目的解析和远端路由。
7. `saved_workflow_list` display 生产者遵循现有 CLI/shared 严格契约：至多 50 个模板、每条至多 32 个参数名、description/whenToUse 各至多 2048、invalid.reason 至多 1024。文本复用 UTF-8 安全限长函数；任一字段或列表被截断即设置既有 `truncated`。保留顺序，不扩展 schema、不剥离未知字段、不因一个超长结果丢弃整张卡。
8. 项目/全局文件扫描结果仍由 CLI 负责，管理页保持 `workflows/list`，工具卡仍使用 `output.display`。本次不改目录监听策略、全局 Host 选取、执行解析优先级或工具调用频率。

## 所有者与事件顺序

- 模板文件是定义的唯一权威；CLI saved-workflow store 负责枚举与 scope。
- core display builder 只构造有界展示摘要；contracts 与 shared 仍独立严格校验同一形状。
- V4 ProductProjection 负责实时与历史会话的工具结果；聊天 renderer 不主动请求模板目录。
- `savedWorkflowStore` 是管理页唯一读缓存；组件只派生 loading/error/empty，不复制 accepted 结果。

```text
模板文件 → ListSavedWorkflows → 有界 display / metadata → ProductProjection
                                                        ├→ Desktop continuous
                                                        └→ 手机 replayable / 冷恢复
                                                                    ↓
                                                          shared strict schema → 历史工具卡

管理页挂载 / 刷新 → savedWorkflowStore.load(target)
                     ├→ listSavedWorkflows → 成功列表或错误
                     └→ listSavedWorkflowRuns → 历史摘要
                  最新请求身份匹配 → 接纳结果 → 加载/错误/列表/真实空态
                  旧请求完成       → 丢弃，不覆盖
```

不修改 owner/lease、订阅序列、运行状态、幂等事实或 Desktop/手机投递语义。

## 验收

- 中英文工具卡均明确模板与运行记录的区别；合法空列表显示提示，失败/解析异常/无效文件不冒充未保存过。
- 1 个合法模板 + 无效文件仍显示模板与警告；只有无效文件时折叠摘要即可辨认错误；截断提示在折叠/展开视图可见。
- 50/51 条模板、32/33 参数、1024/1025 ASCII 原因及多字节长文本覆盖边界；生产结果同时通过 CLI 和 shared schema，持久 metadata 可重新读取。
- 完整/分片帧、continuous/replayable、在线增量/初始快照/恢复/冷历史均保留合法 `saved_workflow_list` 和 `truncated`，不修改历史记录。
- 管理页首次请求失败显示错误，不显示项目空态；点击刷新后成功展示模板。全局组未完成加载时不先显示空目录；已有列表刷新失败仍可见错误。
- 两次刷新乱序返回：后发的成功列表不被旧空结果或旧错误覆盖；不同 workspaceIdentity 保持隔离。
- 浏览器场景使用真实列表卡与管理页组件，验证中英文、浅深主题、桌面和 390 px 宽度；fixture 只替换服务边界，不启动模型或真实工作流。
- 实际执行相关测试、`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，区分本次与现存失败。构建/安装/发布不在本次范围。
