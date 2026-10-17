# Sidebar organization

唯一 owner 是 profile 配置目录下的组织服务。公开 getSnapshot、apply、onDidChange。
仅保存稳定对象引用、分区和位置；不会保存连接、任务、Git 或展开状态。

apply 在跨进程锁内读取文件，先校验 operationId，再比较 revision，原子写入结构和去重记录。
同一 operationId 携带不同内容会拒绝。冲突返回当前快照。所有 mutation 同时成功或均不生效。
editSection 原子提交名称、完整成员顺序和可选默认目标；不会使用过滤后的投影替代成员。
默认目标只允许当前分区直接包含的 project/worktree/executionSet，移动或忘记该引用时同事务清空；撤销恢复完整结构。
首次写入 executionSet 引用时升级为组织格式 version 2；旧版不能把未知引用丢弃后回写，读取未知版本必须拒绝。
变更通知只在提交之后发布；其它 Host 的文件变更也发布单调 revision。每个新订阅会收到当前快照，
包括 RPC 重连后的重新订阅；客户端按 revision 忽略迟到或重复结果。断连也可通过重新读取快照恢复，
不参与会话 continuous/replayable 流。读取失败不生成替代空数据，不能覆盖原文件。

引用只按完整 workspace identity（本地 fallback path）识别。混合分区不改变真实业务归属。
旧分组按来源只读导入一次；导入跳过已有显式位置，不覆盖用户整理，原始业务数据保留。
