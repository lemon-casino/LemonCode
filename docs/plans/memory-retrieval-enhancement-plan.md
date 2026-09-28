# 工作区记忆与检索增强执行方案

> 状态：已完成（2026-09-27）；P1、P2-A、P2-B、P2-C 与 P3 均已实现并通过统一验证；P4 FTS 当前门禁未触发，保持暂缓（deferred），不新增 migration，也不视为永久删除
> 本文只覆盖 Agent 的工作区记忆与同工作区会话检索。会话分享脱敏与 Git 行级归因已从本方案拆出；它们分别属于发布安全和代码归因域，不能与记忆状态共用里程碑或回滚开关。

## 1. 本次审查后的关键修正

| 原方案问题                           | 最终决定                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 把 FTS5 称为“语义检索”               | 统一称为“词法检索”；向量/embedding 仍是显式 opt-in 的远期能力。                                                                                                            |
| `MEMORY.md` 未截断时不做 top-k       | 删除该门控。`MEMORY.md` 只是索引，topic 文件才是事实正文；所有合格真实用户轮次都可召回 topic。                                                                             |
| 用 `commitTurnRequestEntries` 注入   | 改为 turn-local overlay。召回内容只进入当前 turn 的 request state，同一 turn 的 tool/failover model step 复用，下一 turn、冷恢复和持久化历史均不残留。                     |
| `Promise.race(1500ms)` 保护 SQLite   | 删除该承诺。`node:sqlite` 的 `DatabaseSync` 不能被 Promise 超时中断；同步查询只能依靠行数、字节数、会话数和 SQL 计划硬预算，若仍需可取消超时则必须迁入 worker/异步 owner。 |
| 远端 identity 缺失时按目录回退       | 禁止。远端 workspace 只接受精确 `workspaceIdentity`；目录 fallback 只允许当前 workspace 与目标 session 都没有 identity 的 legacy local 数据。                              |
| tasks-index 的普通 upsert 已在事务内 | 事实不成立。后续若加 FTS，必须用 migration + trigger 保证基表/索引原子性，或显式重构全部写路径；不能假设现有事务。                                                         |
| 删除 FTS 表即可回滚                  | 删除该做法。migration ledger 不会自动重建被删虚表；回滚只能停读/切回现有查询，清理需追加新 migration。                                                                     |
| 五项能力一起进入 P2                  | 拆成可独立验证、独立回滚的垂直切片。数据库迁移在 schema、回填和基准被维护者确认前不实施。                                                                                  |

## 2. 产品边界

### 2.1 本方案内

1. 工作区 topic memory 的本地词法 top-k 召回。
2. 记忆 manifest 的有界扫描、增量缓存和中英文检索。
3. `ReadSessionContext` 的同 workspace 隔离。
4. 中文无空格输入也能触发既有后台记忆提取。
5. 同 workspace 会话发现工具、默认关闭的可选自动召回，以及有证据后再启用的 FTS。

### 2.2 本方案外

- 会话分享脱敏：另立发布安全 spec，必须同时说明附件字节是否扫描，不能只改正文却承诺“发布内容均已脱敏”。
- Git 行级归因：另立实验性 provenance spec；Git diff 仍由 `IGitService` 拥有，CLI 只能查询会话证据，不能成为第二个 diff owner。
- 远端 workspace 的自动记忆提取：维持当前禁用语义。
- subagent 的 `.lcode/agent-memory*`：与项目记忆是不同 owner，本期不合并。
- 默认联网、向量数据库或 embedding 服务。

## 3. 不变量与状态所有者

| 状态/事实                       | 唯一 owner                                                               | 读取/派生                                                    |
| ------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `memory/*.md` 与 `MEMORY.md`    | 现有 Memory 写入边界（用户、受限 extraction agent、Write/Edit 权限收口） | core recall 只读                                             |
| topic recall cache              | 单个 `AgentRuntime` 内的 recall index                                    | 由路径 + `mtimeMs` 派生；不持久化                            |
| 当前 turn 的 recall attachments | `RegularTurnLoopState.turnRequestState`                                  | Project Memory / session recall 派生；不写 canonical history |
| session transcript              | CLI `SessionStorePort` 实现                                              | `ReadSessionContext` 只读                                    |
| workspace identity              | 现有 runtime/session 配置                                                | identity 非空时精确匹配；仅 legacy local 允许目录 fallback   |

身份红线：

- 隔离语义始终是 `workspaceIdentity?.trim() || workspacePath`。
- `workspacePath` 只用于文件、命令 cwd、Git 与显示。
- 远端链路不得因目录相同而读取另一个 identity 的 session。
- 本期不改变 `resolveProjectMemoryRoot` 的已有路径构造，否则会造成存量本地记忆目录迁移。

## 4. 当前落地切片：P1 工作区 topic recall 与隔离修复

对应 spec：

- `specs/memory-recall-topk-injection.md`
- `specs/session-context-workspace-isolation.md`

### 4.1 事件顺序

```text
真实用户输入
  → 持久化 user message
  → 建立 turnRequestState
  → micro/auto compact（如需要）
  → 首个 model step 的 memory recall（每 turn 最多一次）
       → scan manifest（有界、异步、单文件失败隔离）
       → path + mtime reconcile runtime cache
       → Han bigram / Latin+identifier tokenization
       → BM25(k1=1.2,b=0.75) + 确定性排序
       → top-k + 单条/总字符预算
       → append 到 turnRequestState（不写 messageHistory/session store）
  → provider request
  → 同 turn tool/failover step 复用同一 recall overlay
  → turn 结束后 overlay 释放
  → 成功 turn 后按现有链路异步 extraction
```

desktop 与 mobile 不新增第二条状态链：

```text
desktop-continuous ──┐
                     ├─ 同一个 Host attachment / AgentRuntime / recall owner
web-remote-replayable┘
```

### 4.2 检索规则

- 候选：memory root 下除 `MEMORY.md` 外的普通 `.md` 文件，最多 200 个；symlink 直接拒绝且不占候选预算，目录项在读取前截断，禁止无界 `Promise.allSettled`。
- 遍历：core 最多消费 128 个目录结果、处理 4096 个 directory entries；目录队列用 cursor 前进，禁止 `shift()` 的 O(n²) front-removal。每次枚举把剩余预算下推为 `FileSystemPort.listDirectory.limit`，Node adapter 流式读取且最多物化该数量；未传 limit 的旧调用仍保持完整列表兼容语义。
- corpus：索引 full-read 与 manifest preview 均显式传入命名的 64 KiB `maxBytes` 上限；stat 后按稳定路径顺序累计，派生 corpus 总预算 4 MiB，禁止让 200 个超大 topic 放大内存与 I/O。
- 并发：文件 stat/preview/full-read 使用固定小并发，不产生第二个后台队列。
- cache：同路径且端口提供的 `mtimeMs` 未变化时复用正文；`mtimeMs` 缺失时每次 reconcile 都重读，不能把缺失值当作稳定 revision；修改后重读；删除或不可读时立即从派生 cache 移除。
- cache 文档在 reconcile 时预计算 term-frequency、token length 与 metadata token set；query-time ranking 不得逐文档重建 Set/Map。
- token：英文、数字、路径和标识符保留；camelCase、snake_case、路径分隔符产生附加 token；连续 Han 文本产生 bigram。
- score：BM25 `k1=1.2, b=0.75`；文件名、description、type 只作为有限字段 boost；同分按文件名稳定排序。
- 结果：默认 top 4、每项最多 4000 字符、总计最多 12000 字符；无正分命中不注入。
- 安全：正文明确标注为背景事实，不得作为高优先级指令；日志只记数量、耗时、字符数与安全错误类型，不记录正文、文件名、绝对路径或原始文件系统错误消息。

### 4.3 触发与失败语义

- 仅 `memory.enabled` 且存在 memory root 时启用，不新增默认开关。
- 仅真实、可见、会持久化的用户输入触发；model-only continuation、内部控制输入和空 query 不触发。
- 每个 turn 在第一个 model request 前最多尝试一次；模型重试、工具续跑和 provider failover 不重复扫描或注入。
- micro/auto/reactive compact 前分离 `memory_recall` 与 `session_recall` overlay，summary、canonical replacement 与 recorded model-request projection 均不得包含它们；compact 成功、跳过或失败后在 `finally` 中把同一 overlay 重附到当前 turn，供后续 live provider step 复用。其他 `runtime_local` source 不受影响。
- scan/read/rank 任一失败均 best-effort：记录结构化 recoverable 日志并继续 turn，不注入全库 fallback，也不使 turn 失败；core 首 token 前工作量通过 128 个目录结果/4096 个已返回 entries/200 候选、固定小并发、单文件 64 KiB 与总 corpus 4 MiB 预算约束。剩余 entry 预算会下推给 `FileSystemPort.listDirectory.limit`，Node adapter 不先完整物化宽目录；替代/旧测试 adapter 仍由 core defensive slice 收口。
- `MEMORY.md` 索引继续留在 context prefix；topic recall 是当前请求的补充，两者职责不同。

### 4.4 同 workspace 会话读取

`ReadSessionContext` 在读取 messages 之前验证目标 `SessionInfo`：

```text
current has workspaceIdentity
  → target.workspaceID 必须精确相等（不允许 path fallback）

current has no workspaceIdentity
  → target.workspaceID 也必须为空
  → target.directory 必须与当前 workspace root 为同一本地路径
```

不匹配统一返回 `not_found` 形态，不泄漏目标 session 是否存在，也不读取目标 messages。

### 4.5 中文提取修复

现有 extraction 的“至少 3 个词”只按空白拆分，中文无空格句会被误判为 1 个词。本期把 Han 字符作为可计数语言单元，同时保留原有英文/数字词规则；这是提取 admission 修复，不改变 extraction owner、调度或写权限。

## 5. 独立切片与门禁结论

### P2：显式 `SessionHistorySearch` 工具（无自动注入）

P2-A 已落地 `FileSystemPort.listDirectory.limit`，由真实 Node adapter 执行有界读取；该节点不承诺并发目录变更下的 snapshot pagination 或全局字典序页面。接口与验收见 `specs/file-system-directory-list-limit.md`。

P2-B 已落地，复用现有 `SessionStorePort.listSessions/messages` 做只读实现：

- 默认排除当前 session、synthetic/model-only/tool/reasoning/control 内容。
- identity 非空只查精确 identity；legacy local 才按空 identity + directory。
- 每次 messages 读取后重新读取 session 元数据并复核 scope，用最新 rewind 边界投影，避免旧 metadata 与新 append-only rows 混用。
- 最多枚举 20 个候选，单会话投影 32,000 字符、总投影 256,000 字符，标题 256 字符、预览 1,200 字符，返回 1–10 条。
- 返回判别联合：`ok`（可为空）或 `unavailable(reason,retryable)`，不能用空数组掩盖基础设施失败。
- 结构化输出记录候选数、core 投影字符数和截断事实，通用 tool span 记录耗时/序列化截断；不记录正文。P2-B 初版的 `messages()` 会整会话物化，P2-C 已为生产 SQLite 搜索路径补上独立 row/JSON-payload 上限；两者都不把 core 字符数冒充 SQLite page I/O 或 decoded heap 上限。
- agent 通过显式工具调用决定何时搜索，结果作为 untrusted background，再用现有 `ReadSessionContext` 深读选中的 session。

只有基准证明 bounded scan 不满足预算时，才提交数据库 migration 设计评审。

P2-C 收口 P2-B/P3 已知的整会话物化缺口，接口与验收见
`specs/session-transcript-bounded-snapshot.md`：

- `SessionStorePort` 新增 optional `readTranscriptSnapshot`；生产 SQLite adapter 在一个 read
  savepoint 内返回同一快照的 `SessionInfo` 与有界 transcript，旧宿主保留
  `messages + getSession` fail-closed 降级路径。
- 显式搜索每候选最多 256 条 message、1,024 条 part、262,144 persisted JSON data bytes；自动
  召回收紧为 96/384/98,304。超限采用确定性前缀并传播 `truncated`，不跳过超限行继续扫描。
- byte count 只承诺返回到 JavaScript 的 message/part JSON `data` payload 上限，不冒充 SQLite
  page I/O、固定列或 decoded-object heap 上限；不新增 migration、缓存或第二状态 owner。

### P3：可选的 turn-start session recall

P3 的手动 opt-in 路径已落地，接口与验收见 `specs/session-history-auto-recall.md`：

- 独立 `sessionRecall.enabled` 设置，默认关闭；不能隐式跟随 `features.memory` 或 `memory.use`。Headless CLI 继续使用 README 中的 JSON 配置；App 在“设置 → 记忆”通过 `AppSettings.sessionRecallEnabled` 开关控制新建/冷恢复的 protocol session，经现有 runtime-preferences RPC 物化，不新增 UI-local 状态。标题旁的 `?` 支持 hover 与键盘 focus，说明同工作区范围、只读上下文和生效时机。
- 在真实、可见、会持久化的用户输入已知后，完成 compact 与 Project Memory recall，再于首个 provider request 前执行；无 query 的 cold resume、model-only、automation、off-peak 与 child runtime 均不执行。
- 复用 P2-B 的 identity-first scope、metadata refresh、active rewind branch、文本过滤与词法排序；自动路径进一步收紧为候选 8、单会话 12,000 字符、总投影 64,000 字符、最多 3 条、单预览 600 字符、attachment 3,200 字符。
- 排除当前 session，结果只做 `session_recall` turn-local overlay；compact/persistence 与 recorded model request 会同时剥离 `memory_recall`、`session_recall`，不持久化过期快照，也不伪造工具调用或自动深读。
- 多语言离线 fixture 在测试中计算 precision 与 false-positive gate；运行时仅记录无正文的 duration/count 指标。工程门槛为 precision@3≥0.80、false-positive query rate≤0.10、代表性持久库新增 pre-request latency p95≤150 ms 且 p99≤300 ms，当前实现已全部通过。默认关闭保留为独立产品安全决策。
- 固定语料、统计定义、失败退出语义与可复现命令见
  `specs/session-history-recall-benchmark.md`。2026-09-27 Windows x64 实测 200 次：p95=75.113ms、
  p99=84.634ms，输出不变量 0 失败，证据见
  `docs/benchmarks/session-history-recall-2026-09-27.md`。性能通过只关闭工程门禁，不自动改变
  默认关闭的产品合约。

### P4：FTS 门禁结论

P4 当前不实施，状态为 `deferred / not triggered`，而不是“永久不需要”。当前产品合约只在同工作区
最近的有界候选中召回：自动路径最多 8 个候选，显式工具最多 20 个候选；在这个边界内，固定
production-SQLite 语料的 p95/p99 均通过 P3 门槛，现有证据不足以支持立即承担 FTS migration
及索引一致性成本。因此：

- 不创建 tasks DB `0004` 或 CLI DB `0024`；
- 不新增 shadow table、trigger、回填任务或 FTS 查询构造器；
- 2026-09-28 使用同一命令复测 200 次，得到 cold=65.677ms、p95=39.502ms、p99=48.407ms、
  failures=[]，仍远低于 p95≤150ms、p99≤300ms 门槛；多语言质量与统计判定聚焦测试 3/3 通过；
- FTS 不是当前功能正确性的依赖。现有 bounded snapshot、workspace identity 隔离、active rewind
  branch、可见文本过滤和词法排序均由共享 search service 保持，直接把原始 message/part JSON
  接入 FTS 反而会引入隐藏内容、废弃分支或 tokenizer 语义漂移风险。

现有通过证据只说明“当前 checkout、当前机器、当前有界热路径足够快”，不能外推为全历史和所有
生产环境的永久结论，审计时确认以下证据边界：

- 固定语料只有 9 个 prior session，每个 64 条 message、每条 2 个 part；没有打满自动路径的
  96 message、384 part、98,304 persisted JSON bytes 上限，也没有覆盖高 session 基数；
- 五个 benchmark query 都写入每个候选 transcript；输出校验只要求非空和不超过上限，没有断言
  期望 session、排序、preview、`failedSessionCount === 0` 或最低扫描数量；
- `coldMs` 是同一连接完成建库和 seed 后的首次读取，只做观察、不参与门禁；p95/p99 来自 25 次
  warm-up 后的 200 次连续调用；
- precision fixture 直接评估 6 个预制候选的 ranker，没有经过 SQLite、候选截断，也没有覆盖唯一
  相关结果位于第 9 个或更旧 session 的 recall@k；
- 当前 search service 先按更新时间取得最新候选再做文本排序，因此它提供的是“最近 8/20 个候选
  内检索”，不是“整个工作区全历史检索”。这是当前已接受的产品边界，而不是 FTS 已解决的能力。

仅在下列任一条件出现时重新开启 P4 独立设计评审：

1. 脱敏生产 telemetry 在代表性环境中持续超过 p95 150ms 或 p99 300ms，且 profiling 确认瓶颈
   位于 transcript 文本扫描，而不是 session metadata 枚举、磁盘或其他路径；
2. 产品目标改为跨整个工作区历史查找最相关会话，或大历史库 evidence 显示相关 session 经常落在
   最近 8/20 个候选之外；
3. 补充打满 row/part/byte 边界、高 session 基数、跨平台和重复运行的基准后，稳定越过门槛，或
   端到端 recall@k 低于另行确认的产品门槛。

若未来瓶颈只是 workspace scope 下按 `time_updated` 取得最新 session，应先评估匹配过滤与排序的
复合 B-tree metadata index；这类问题不能用 FTS 替代。确需 FTS 时，仍必须另立 spec 与 migration
评审，并遵守 append-only migration、基表/索引原子性、启动能力探测、active branch/可见文本一致性
以及停读不删表的回滚约束。

## 6. 验收矩阵

| Case   | Setup / action                           | 必须断言                                                                                  |
| ------ | ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| MR-01  | 中英文 topic 与中文 query                | 相关文件入 top-k，无关文件不入                                                            |
| MR-02  | camelCase、snake_case、路径 query        | 标识符可命中且排序稳定                                                                    |
| MR-03  | memory 文件新增、修改、删除              | 下一真实用户 turn reconcile；不返回 stale 内容                                            |
| MR-04  | 单文件不可读                             | 跳过该文件，其余结果正常，turn 不失败                                                     |
| MR-05  | >200 文件                                | 读取前有界，不创建无界 promises                                                           |
| MR-06  | 同 turn 多 model step/failover           | 只扫描、注入一次                                                                          |
| MR-07  | 下一 turn/cold resume                    | 上一 turn recall attachment 不残留                                                        |
| MR-08  | 12000 字符以上候选                       | 单项与总预算均生效                                                                        |
| MR-09  | 中文无空格用户输入                       | extraction admission 不再误跳过                                                           |
| MR-10  | topic 文件超过 64 KiB                    | full-read/preview 请求携带 64 KiB 上限；索引内容不超过有界读取且 turn 不失败              |
| MR-11  | symlink 排在普通 topic 前                | symlink 不 stat/read、不占 200 候选预算，root 外目标不可见                                |
| MR-12  | 宽/深目录与大文件集合                    | core 消费目录结果≤128、已返回 entries≤4096、corpus≤4 MiB；真实 adapter 不先物化完整宽目录 |
| MR-13  | adapter 不提供 `mtimeMs`                 | 每次 reconcile 重读，修改后的正文不会被 `0` revision 旧 cache 遮蔽                        |
| SI-01  | 本地同目录、双方无 identity              | `ReadSessionContext` 可读                                                                 |
| SI-02  | 当前远端 A、目标远端 B、路径相同         | 返回 not_found，且不调用 messages                                                         |
| SI-03  | 当前远端 A、目标 legacy NULL、路径相同   | 返回 not_found，禁止远端 path fallback                                                    |
| SI-04  | 当前/目标 identity A 相同                | 可读；desktop/mobile delivery 不改变结果                                                  |
| SAR-01 | `sessionRecall.enabled` 缺省或 false     | 不读取 session store，不生成 overlay                                                      |
| SAR-02 | 自动召回开启、Project Memory 关闭        | 自动召回仍可运行；两套配置互不替代                                                        |
| SAR-03 | 同 workspace 有正分历史命中              | 一次性、严格有界 `session_recall` overlay；不进入 canonical/persisted history             |
| SAR-04 | 自动召回无命中、存储失败或 child turn    | 不注入、不泄漏存储错误，主 turn 继续                                                      |
| SAR-05 | App 开关缺省/关闭或旧 Host 不发送新字段  | 协议兼容默认关闭；新建 session 不启用自动召回                                             |
| SAR-06 | App 开关开启后新建或冷恢复 session       | Setting service 持久化；Host 下发 true；runtime 显式物化 `sessionRecall.enabled=true`     |
| SAR-07 | hover/focus 自动召回标题旁的 `?`         | 中英文 Tooltip 解释用途、同 workspace 边界、只读语义和仅新 runtime 生效                   |
| BTS-01 | SQLite 会话超过 message/part/byte 上限   | 返回确定性前缀，payload 不越界，`truncated=true`                                          |
| BTS-02 | 搜索宿主提供 bounded snapshot capability | 同一 SQLite read snapshot 返回 metadata/rows；不再调用 legacy messages/getSession         |
| BTS-03 | 旧宿主未提供 bounded snapshot capability | 保留 messages→metadata refresh 的 fail-closed 路径                                        |

## 7. 真实验证入口

仓库没有统一 test script；CLI 各包也没有 `test` script。禁止使用会 0 tests 假绿的 `pnpm -C apps/lcode-cli --filter ... test`。从仓库根执行显式测试文件：

```text
pnpm exec tsx --test <新增的显式 .test.ts 文件>
pnpm --dir apps/lcode-cli bench:session-recall
pnpm typecheck
pnpm lint
pnpm fmt:check
pnpm -C apps/lcode-cli typecheck
pnpm -C apps/lcode-cli lint
pnpm -C apps/lcode-cli format:check
pnpm architecture:check --changed
```

`pnpm verify:pre-push` 目前只含 lint 与 architecture check，不能替代 typecheck 和测试。Node 版本以 `mise.toml` 的 24.14.0 为准；版本不一致必须如实报告 warning。

## 8. 架构决策记录

```text
owner: AgentRuntime owns the Project Memory cache; SessionStore owns transcripts; TurnRequestState owns recall overlays
command path: visible real user turn → bounded memory/session recall → lexical rank → turnRequestState overlays
derived views: MEMORY.md prefix overview + current-turn topic snippets + optional prior-session previews
ordering/idempotency: after compact, before first provider request; each enabled recall path attempts once per turn
delivery: both profiles reuse the same runtime owner; no client-side queue/cache
contracts/spec/tests: core memory recall + explicit/automatic session recall + ReadSessionContext workspace guard + explicit node:test files
migration boundary: no DB/protocol/schema migration; P4 is deferred/not triggered under the current bounded contract and must be re-reviewed when its recorded gates fire
```

## 9. 已知治理缺口

- feature boundary graph 原缺少 memory/retrieval 节点，本次已补充 verified seeds；其 maintainer contract `docs/skills/feature-boundary-graph.md` 在当前 checkout 缺失，因此只做可由 YAML 自身规则验证的最小更新。
- `shared/services/session/ui/lcode-cli` 当前均为 `managed:false`，`architecture:check` 通过不代表这些模块的依赖方向已被机器证明；实现仍需人工核对 package exports 与依赖。
- `architecture-policy.yaml` 登记的 `packages/services/src/session/contract.ts` 当前不存在，属于既有 graph/policy drift，本次不伪造无关 contract。
- 当前文件端口没有 no-follow/lstat 或原子的 contained-read，P1 只能拒绝 `listDirectory` 当时报告的 symlink；若另一本地进程在 list 与 read 之间替换文件，彻底消除该 TOCTOU 需要先扩展 `FileSystemPort`，不得靠重复 stat 声称已形成原子沙箱。
