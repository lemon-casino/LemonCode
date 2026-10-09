# 首次引导步骤契约

引导是新用户进入工作区前的四步向导。本文件记录**步骤结构、跳过语义与保存边界**这一层契约；各页涉及的业务规则由对应功能 spec 持有（主题见 [ui-theme-modes.md](./ui-theme-modes.md)，执行与审核见 [git-commit-review-settings.md](./git-commit-review-settings.md)）。

## 步骤结构

四步按顺序推进，序号类型与总步数唯一定义在 `packages/ui/src/onboarding/onboardingSteps.ts`，组件、进度指示器与遥测都从这里取，不再各写 `0 | 1 | 2 | 3` 字面量。

| 步骤 | 标题 key          | 内容                                  | 保存去向                                                          |
| ---- | ----------------- | ------------------------------------- | ----------------------------------------------------------------- |
| 0    | `stepRole`        | 工作方向                              | `AppSettings.onboardingOccupation`                                |
| 1    | `stepMode`        | UI 模式                               | store `interfaceMode`                                             |
| 2    | `stepPreferences` | 助手偏好（主题 + 记忆 + 推荐 + 迁移） | 主题进 store `theme`；其余进 `AppSettings`                        |
| 3    | `stepExecution`   | 新会话的执行与审核                    | `AppSettings.defaultSessionExecutionMode` / `gitCommitReviewMode` |

- 进度条按 `ONBOARDING_STEP_COUNT` 渲染，无障碍名称数组长度必须与之一致（不一致时模块加载即抛错，避免漏改一处后进度条静默少一段）。
- 每页标题与说明由该页的 key 决定；`preferences` / `execution` 两个布尔派生自 `step`，不额外存状态。
- 第 0 步的「下一步」在未选职业时禁用；其余步骤无必填项。

## 跳过语义

「跳过」按钮**只作废当前页并前进**，不是取消整份引导。各页处理不同：

| 步骤 | 点击跳过                                                                    |
| ---- | --------------------------------------------------------------------------- |
| 0    | `occupation` 置 `null`（记录里记 `null`）                                   |
| 1    | `mode` 置 `null`（记录里记 `null`）                                         |
| 2    | `preferencesSkippedRef` 置真；记忆与推荐落保守默认 `false`，记录里记 `null` |
| 3    | 直接完成引导，且**不写**执行与审核两项                                      |

- 步骤 2 与 3 的区别来自字段性质：记忆/推荐是引导专属偏好，跳过即落保守默认；执行方式与提交审核是**既有配置**，跳过时必须保持原值（见下）。
- 「跳过」在任一页都不修改 `onboarding-record.json` 之外的历史配置，也不触发迁移对话框。

## 保存边界

引导结束时一次性提交（`useOnboardingSave`），顺序为：写设置 → 上报退出埋点 → 追加本地记录。

```text
点「开始使用」或最后一步「跳过」
  → update(AppSettings 补丁)
  → captureEnd(start | skip)            退出埋点
  → appendRecord(onboarding-record.json) 本地记录，5s 超时保护
  → 关闭引导、标记已完成
```

- **只有用户真正改过的既有配置才写入。** `executionEditedRef` 为假时补丁不含 `defaultSessionExecutionMode` / `gitCommitReviewMode`。二者不是引导专属偏好：跳过或未走到第 3 步时若写默认值，会把用户在设置里配好的工作树模式或审核模式静默重置。该边界由 `buildOnboardingSettingsPatch` 承担并有单测锁定。
- 步骤 1 的 UI 模式是**运行时 store**（`setInterfaceMode`），不走 `AppSettings`；`mode` 为 `null`（被跳过）时不改 store。
- 步骤 2 的主题同样是 store（`setTheme`），选择即生效并写入 `localStorage`，**不进入**引导的 settings 提交：跳过偏好页不回退用户已选主题。
- 记录写入失败只记 warn，不回滚已保存的设置，也不让保存按钮继续转圈；下次启动按记录会再次触发引导。
- 引导重新打开时按该用户在记录里的最近作答预填，异步到达不得覆盖用户已做的选择（`userEditedRef` 守卫）。

## 遥测

退出埋点只在保存成功后上报，字段与答案在点击时冻结，不读被 skip 改写的 settings。

- `work_direction`：职业映射值，未选为 `"null"`。
- `ui_mode`：仅当访问过步骤 1 且 `mode` 非空时上报，否则 `"null"`。
- `workspace_memory_enabled` / `proactive_task_recommendations_enabled` / `claude_code_history_migration_selected`：仅当访问过步骤 2 时上报真实值，否则 `"null"`。
- `exit_action`：`start`（完成）或 `skip`（最后一步跳过）。
- `exit_step`：`step + 1`，取值 1–4。

## 验收场景

- 四步顺序推进，进度条为 4 段；中英文下标题、说明与选项文本完整，桌面与 390px 窄屏均无横向溢出。
- 每页「跳过」只前进该页；步骤 0/1 的答案在记录里为 `null`，步骤 2 的记忆/推荐在记录里为 `null` 且设置为 `false`。
- 最后一步「跳过」完成引导但不写执行与审核两项，也不弹出迁移对话框。
- 未修改第 3 步时保存不产生这两项写入；修改后保存，设置 → 常规回读为相同值。
- 引导期间 Escape 直接退出：不保存、不改记录，本次会话不再显示，下次启动按记录重新触发。
- 切换 UI 模式快捷键在引导内可用，并按新模式的默认值同步记忆/推荐勾选（用户未手动改过推荐时）。
- 关闭引导后 `document` 不残留引导层；保存中重复点击「开始使用」或「跳过」只提交一次。
