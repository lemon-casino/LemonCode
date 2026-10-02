# 记忆设计参考：Claude Code 与 OpenAI Codex

核查日期：2026-10-02。仅使用官方文档或公开源码；机制参考不等于质量/成本实测，更不代表复制对方实现。LCode本轮行为以 [实施契约](./workspace-memory-intelligence-implementation.md) 为准。

## Claude Code：选择性保存与渐进读取

- [Memory](https://code.claude.com/docs/en/memory) 区分人维护的 `CLAUDE.md` 和自动积累经验的auto memory。自动记忆不是每次会话必存，不应重复抄录能从代码或Git取得的信息。
- [How it works](https://code.claude.com/docs/en/memory#how-it-works) 描述小索引加topic文件：启动只加载 `MEMORY.md` 前200行或25KB，以先达到者为准；正文按需读取。`CLAUDE.md` 的少于200行是建议，不是同样的硬截断。
- [Subagents](https://code.claude.com/docs/en/sub-agents#enable-persistent-memory) 的持久记忆按user/project/local显式配置，不能假定所有子代理共享主会话记忆。
- [Skills](https://code.claude.com/docs/en/skills) 先暴露名称/描述，使用时读正文；[上下文压缩](https://code.claude.com/docs/en/how-claude-code-works#when-context-fills-up) 处理会话历史，不等于写入长期事实。
- 官方资料没有证明“每轮结束固定调用两次AI审核记忆”。[Background token usage](https://code.claude.com/docs/en/costs#background-token-usage) 的后续提示建议调用也不能被拿来证明记忆内部链路。

本轮吸收：保留小索引、topic按需召回、禁止把代码已有事实重复入库、无候选不做第二次核验、子代理不自行启动工作区复盘。不引入额外UI或新的知识库服务。

## OpenAI Codex：有界提取、变更驱动整合与运行水位

固定公开源码版本：[b707714ae4200db0a0385da24b3981d99139fa62](https://github.com/openai/codex/commit/b707714ae4200db0a0385da24b3981d99139fa62)。该版本与网站默认值有差异，下面以固定源码为准，未来版本可能变化。

- [Feature开关](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/features/src/lib.rs#L1189-L1200) 中memories是Stable但默认关闭；不将“稳定级别”等同默认启用。
- [后台入口](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/memories/write/src/start.rs#L20-L91) 和 [默认配置](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/config/src/types.rs#L55-L60) 展示候选资格、闲置时间和每次处理上限。它不是当前用户每轮结束就必跑的双审。
- [Phase2](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/memories/write/src/phase2.rs#L122-L173) 对无变化且有效产物可跳过，并有租约/冷却；watermark记进度，diff决定是否有新工作。
- [提取规则](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/memories/write/templates/memories/stage_one_system.md#L16-L38) 把rollout与第三方工具内容视作数据、允许空结果、要求可复用价值。Phase1提取、Phase2整合不等于生成者+独立验证者两次请求。
- [读取路径](https://github.com/openai/codex/blob/b707714ae4200db0a0385da24b3981d99139fa62/codex-rs/ext/memories/templates/memories/read_path.md#L19-L46) 采用有界摘要、关键词发现与少量来源按需读取，不把所有原始历史加载给模型。

本轮吸收：有界完成轮窗口而不是全历史扫描；已有scheduler的cursor与pending合并；候选内容不变直接省去写入；source版本可追溯；拒绝候选/失败不污染当前事实；持久journal和重放幂等。不照搬其全局跨项目整合、后台内部Agent、指定模型名称或大输入预算。

## LCode本轮的区别

1. 沿用当前完成轮的已选模型及provider，不另买模型或起Agent。核验用新messages，是上下文独立，不是供应商/模型独立，也不保证AI判断必然正确。
2. 自动路径为增量档：仅1个已完成真实用户轮、会话最多6000字符、最多2条相关记忆合计4000字符。每次请求最多6000估算输入tokens；生成/核验输出分别最多1536/768。两次合计理论上限约12000估算输入+2304输出，非平均值，provider计数和重试仍可能有差异。
3. 空候选不核验、不保存空提案；没有有效当前来源时不调用模型。完整跨会话复盘只由用户明确发起，不每轮自动扫描8个历史会话。
4. AI只提出并审核Markdown记忆内容；源码、权限、技能、凭据和系统指令不在自动写范围。来源/hash/路径与冲突检查由程序做，不能被AI的accept绕过。
5. 文件满额或恢复异常时保留用户事实，记录明确原因；不静默丢历史、不假装始终健康。真实模型质量、平均token与长期效果需要后续真实使用统计，本轮fake测试不证明节省百分比。

## 暂缓而非宣称已完成

跨项目共享、使用次数驱动衰减、持久配额/多天冷却、跨Host统一后台维护、embedding/vector检索、归档/多文件事务均不在首版。特别不把Codex的6小时冷却直接套到本轮最新用户纠正上，也不为了减少token而跳过对实际写入的校验。
