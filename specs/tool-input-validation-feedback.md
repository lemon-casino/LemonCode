# 工具参数校验反馈

## 规则与已确认原因

`sess_6a7db596-f1f7-4555-9f2a-baf6506fcafe` 的工作流子代理 `submit_result` 曾漏传 schema 必填字段或多传 `positioning_note`；原校验正确拒绝，模型随后修正且所有对应提交均成功。不能删除必填项、剥离额外字段或伪造缺失结果来消除失败记录，也不能保证非严格解码模型永远不犯参数错误。

- typed `submit_result` 的描述从同一冻结 result schema 派生完整顶层 required 清单，提醒模型一次提交完整对象、不引入额外字段，不能仅补本次报错字段而漏掉上一版字段。通用声明仍由当前 ask 的 schema 指令负责，不冻结另一 ask 的形状。
- 首次模型输入校验失败的 provider-visible `modelContent` 已有明确字段/类型问题；executor 复用该内容生成有界可读的错误摘要，供现有事件、历史和 UI tooltip 消费。错误类别、原始验证错误、模型修复通道与失败态不变；不复制输入值或增加协议字段。
- Hook/权限修改后的输入校验失败不能冒充首次模型参数错误；仍用现有错误投影。handler 拒绝、权限反馈和 provider cause 的摘要语义不变。
- 不为兼容供应商擅自启用 strict 参数，不新增模型调用、自动重试、队列或缓存；实际引擎始终是结构化终态结果的唯一裁决者。

## 所有者与顺序

```text
冻结 actor result schema → 原 submit_result 工具声明 + required 清单
模型输入 → 原 executor 初次校验
         ├─ 无效 → 原 modelContent → 同一有界错误摘要/事件 → 模型同会话修正
         └─ 有效 → handler → 原 WorkflowSubmitPort/引擎裁决 → 接受才结束 turn
desktop continuous / mobile replayable ← 同一错误事件与历史，不新增消费事实
```

## 验收

1. 五字段 typed 结果遗漏字段或含额外字段仍拒绝；工具描述列出全部必填字段，原 schema 不修改。
2. 错误摘要明确包含缺失/额外字段路径，modelContent 与类别保留；无效提交不调用引擎、不挂停止信号。
3. 提交完整结果通过原 handler，普通工具、Hook/权限反馈和通用声明不回归；摘要保持现有 500 字符上限。
4. 根 typecheck、Lint、changed 架构检查及 CLI 相关检查执行并记录；测试不调用真实模型或写入用户会话。

## 2026-10-02 验证记录

- 影响模块为 `lcode-cli` 与 `services`：冻结 schema 与原 executor/工作流引擎仍是参数接受的唯一裁决路径；Git 纪要与审核共用现有消息校验器，不新增请求状态、自动重试或平台分支。Desktop continuous 与 Mobile replayable 仍消费同一结果/错误，不修改订阅顺序或恢复协议。
- 5 项 CLI 定向测试与 17 项服务测试通过，覆盖字段缺失/多余、完整重交提示、handler 前拒绝、有界错误摘要、权限反馈原文、Markdown 中文标题、审核失败后独立纪要、审核候选严格校验和隔离临时仓库的实际提交。未调用真实模型、修改用户会话或提交用户仓库。
- 根 `pnpm typecheck`、`pnpm lint`（0 warnings/errors）、Core 自有 TypeScript 类型检查、11 个本次触及文件格式检查与 `git diff --check` 通过；`pnpm architecture:check --changed` 为 baseline 0 / new 0。相对编辑前基线，本次代码和测试净增 166 行，不将共享工作树既有改动算作本轮改动。
- CLI 全包 `pnpm check` 因既有 Bash registry 生成物过期停在 registry 检查；单独 `pnpm typecheck` 的入口又受当前 CLI 本地 `turbo` 命令缺失影响。未为消除这些非本轮原因而生成无关文件或变更依赖；Core 直接使用其自有 TypeScript 检查已通过，不能将其写成全 CLI 检查通过。
- 现场 `submit_result` 的真实参数错误后来已自行修正并被接受；本次只改善后续提交提示和错误摘要，不抹除历史失败、不承诺模型永不产生无效参数。未构建或安装，新包真实任务验收留待后续构建。
