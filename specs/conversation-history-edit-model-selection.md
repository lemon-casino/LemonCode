# 历史会话编辑提交的模型选择

## 产品规则

1. 在已打开的历史会话中编辑最后一条可编辑用户消息并提交时，使用主 Composer 当前已经通过 ModelSelectionView 校验的完整 `ModelSelection`，包括 provider、model、reasoning level 和 speed；不能继续静默复用被编辑消息的旧模型。
2. 模型选择在编辑点击提交的瞬间冻结。提交等待、网络传输、rewind 或 runtime 初始化期间，用户对 Composer 的后续改选只影响下一次提交，不改变本次编辑。
3. 编辑命令仍是 `editUserQuery` 的单命令路径：它在同一 admission 中完成目标校验、必要的活动轮终止、workspace rewind、conversation rewind 和新 prompt 启动。不得先发送独立的 `switchModelConfig` 再发送编辑命令。
4. 编辑使用当前选择后，该选择成为 runtime 接受的会话模型；后续普通发送、队列/Guide drain、冷恢复和历史投影都读取同一份 canonical input intent / runtime selection。
5. 旧客户端缺省 `modelSelection` 时保持兼容：CLI 使用被编辑用户轮的 canonical selection；若历史事实也没有选择，则沿用既有 runtime/session fallback。`retryTurn` 不改变其复用原 canonical selection 的行为。
6. 模型目录或选项校验未完成、选择无效或模型不可用时，UI 不提交未经校验的编辑，并保留行内编辑草稿。UI 不从历史 row 的 provider/model 或 snapshot 的扁平 effective 字段拼出替代选择。
7. 文本、附件、`workspaceMode`、latest real-user query 限制、CAS、幂等和 workspace rewind 的 fail-closed 语义保持现有规则：空正文且无附件拒绝；显式空附件数组表示删除全部；rewind 被阻断时不截断会话历史或文件。

## 所有者与接口

- Composer 草稿与当前未提交的 `ModelSelection` 由 `useDraftConfigControl` 按 workspace/session scope 拥有。
- `SessionPane` 在编辑提交边界调用现有 `createComposerSubmissionConfig`，只读取已校验的 Composer draft，并把冻结的 `modelSelection` 放入 `editUserQuery` payload。
- 共享 v4 command schema 拥有 edit payload 的线格式；`modelSelection` 为可选字段，以兼容旧客户端。
- CLI admission、`ConversationInputIntent`、transcript persistence 和 runtime 共同传递同一份选择；不得另建 UI 或 handler 私有缓存。
- runtime 在 turn admission 前冻结并校验本轮选择，应用会话选择、持久化并发布 `ModelSelected`，随后运行编辑后的 prompt。

## 事件顺序

```text
Composer draft + ModelSelectionView
  -> 点击历史编辑提交
  -> 冻结完整 ModelSelection
  -> editUserQuery admission / canonical intent
  -> 目标与附件校验
  -> （必要时）停止活动轮
  -> （rewind 模式）安全恢复 workspace 文件
  -> conversation rewind
  -> runtime 应用并持久化本次 ModelSelection
  -> 发布 ModelSelected / TurnStarted
  -> 新文本按冻结选择执行
  -> live snapshot / transcript / 后续提交读取同一选择
```

Desktop continuous 与 mobile web-remote-replayable 都必须遵循同一命令顺序和 intent 字段；relay/transport 只转发，不拥有模型选择或编辑队列。

## 失败语义

- 目标过期、CAS stale 或 command 被拒绝时，不修改编辑行的历史事实；UI 按既有 ACK/recovery 处理。
- 附件映射失败发生在 rewind 前；文件 rewind preview 不安全、存在 ignored 文件或无法应用时返回 blocked preview，不提交 conversation rewind，也不应用模型选择。
- runtime 无法解析当前 provider/model/options 时，编辑提交失败，历史 rewind 已发生时沿用现有 runtime 的失败/错误投影；不得自动改用旧模型或另发第二个 edit command。
- ACK duplicate 仍按原 command 幂等边界处理；重放不会再次产生不同模型选择或重复运行。

## 验收

- 主会话从供应商 A/模型 A 切到供应商 B/模型 B（含非默认 reasoning/speed），打开历史会话最后一条用户消息编辑并提交；单个 `editUserQuery` payload 带完整 B 选择，新轮按 B 执行并发布对应模型投影。
- 编辑提交前再次修改 Composer 选择时，只使用最后一次已校验选择；提交后的改选不影响已提交编辑。
- 模型选择目录 loading/error 或选项非法时，编辑命令不发出，行内文本和附件草稿仍保留。
- 旧 edit payload 无 `modelSelection` 仍成功，并复用 canonical 历史选择；`retryTurn` 仍复用原轮选择。
- preserve/rewind、附件显式 `[]`、空输入、latest-only、stale/duplicate 与冷恢复行为保持既有验收结果。
- live projection 与冷恢复 transcript 均保留编辑新轮的完整 modelSelection options，后续普通发送使用该已接受选择。
