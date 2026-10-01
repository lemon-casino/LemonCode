# 后台 Agent 结果交付与 TaskOutput 边界

## 产品规则

- `Agent` 显式或自动转入后台后，启动结果只表示任务已被接受，不表示结果已就绪。父任务可继续处理不重叠的工作；无其他工作时结束当前 turn，由终态通知唤醒并汇总结果。
- 后台 `local_agent` 的正常结果入口是 runtime 投递的终态通知。模型不得为了等它而反复调用 `TaskOutput`，也不得读取 Agent 的 `.output` 会话记录文件。
- `TaskOutput` 对仍在运行的后台 `local_agent` 只返回即时 `not_ready` 状态，即使输入 `block: true`；不得进入等待循环、读取会话记录文件或将任务标记为已通知。返回给模型的内容必须明确提示等待自动通知。
- `TaskOutput` 查询已终止的 `local_agent` 可返回当时的结果快照，但该查询不得认领或抑制自动终态通知。其他任务类型的等待和通知语义保持现有契约。
- 任务 ID 是不透明标识；查询必须使用工具结果给出的原值。不存在的 ID 返回明确的 not-found 错误，不猜测或近似匹配到其他任务。
- 用户通过现有停止入口取消前台 turn 或后台任务。查询超时、`not_ready` 和上游模型服务失败均不得自动触发取消。

## 所有者、接口与时序

```text
Agent 启动 → 子 Agent runtime → RuntimeTaskRegistry（任务状态唯一所有者）
                            ├─ 运行中 TaskOutput → 即时 not_ready，无通知认领
                            └─ 终态 CAS → 终态通知入父 runtime 队列 → 父 turn 处理结果
```

- `Agent` 工具的 provider 描述与模型可见启动结果负责引导父模型结束等待；`TaskOutput` 工具描述不得同时鼓励对后台 `local_agent` 阻塞轮询。
- `RuntimeTaskRegistry` 保存任务状态；`TaskOutput` 只读快照。终态通知的去重、入队与消费继续由现有 runtime 通知路径负责，不新增第二条完成结果写入路径。
- 同一任务的终态由既有执行代次与 CAS 边界保护；迟到的查询不得改变终态或压掉通知。前台 turn 的停止和后台任务的显式取消沿现有命令边界处理。
- 父 runtime 的通知持久化入口在成功写入单条或批量通知后，逐项发射 `BackgroundTaskResultConsumed`，携带 workId、registry 的 lifecycleId 和持久 messageId。Agent 复用现有执行 span；其他后台任务由 registry 注册新生命周期 id。V4 移除对应后台工作，并按生命周期记录消费水位防止迟到终态复活；新启动或 SendMessage resume 建立新生命周期，旧消费事实不得抹掉新一代工作。
- Desktop 使用连续事件流展示运行、终态与消费；手机 Web 通过同一可恢复投影重放相同通知。消费事件只补齐内部事实，外部仍使用现有 `state.updated.backgroundWorks` schema；不新建命令或远端 attachment。

## 验收场景

1. 同一轮启动三个后台 Agent，启动提示明确要求等待自动通知，模型不再收到鼓励阻塞轮询的 `TaskOutput` 描述。
2. 对运行中的 `local_agent` 调用 `TaskOutput(block: true, timeout: 120000)` 立即得到 `not_ready` 和停止轮询提示；任务保持 running，之后仍可送达一次终态通知。
3. 对已完成的 `local_agent` 调用 `TaskOutput` 可读取快照，且不设置 `notified`；通知路径仍能按既有规则交付。
4. 对不存在的任务 ID 保持明确错误；对 Bash、远程任务及 workflow 的 `TaskOutput` 语义不变。
5. 上游 429/503 在既有重试上限后成为 Agent 失败终态并通知父任务；本次不修改 provider 重试策略。
6. active-loop 内联结果与 outer-drain 批量结果均移除已消费的后台工作；重复消费幂等，迟到终态不复活条目，新一代不被旧通知移除。
