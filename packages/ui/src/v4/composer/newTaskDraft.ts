import type { ModelSelectionView } from "@lcode/services";
import type { ModelSelection, SessionDefaults } from "@lcode/shared";
import { readComposerRecent, resolveDraftInitialModelSelection } from "@/lib/composerRecent.js";
import {
  persistV4ComposerDraft,
  readV4ComposerDraft,
  V4_DRAFT_SCOPE_ROOT,
  type V4ComposerDraft,
} from "@/v4/composer/composerDraftStore.js";

/** 普通新任务与首次分享导入共用初始化；保留 Recent 原意图，由公共 View 解析有效选择。 */
export function initializeNewTaskDraft(
  draft: V4ComposerDraft,
  workspacePath: string,
  workspaceIdentity: string | undefined,
  view: ModelSelectionView,
  defaults?: SessionDefaults,
): V4ComposerDraft {
  const recent = readComposerRecent(workspacePath, workspaceIdentity);
  const resolved = resolveDraftInitialModelSelection(
    view,
    recent?.modelSelection ?? null,
    defaults?.modelSelection,
  );
  return {
    ...draft,
    initializeFromNewTask: undefined,
    mode: defaults?.approvalMode ?? (recent?.mode === "plan" ? "build" : (recent?.mode ?? "build")),
    planEnabled: false,
    // 初始化 IO 期间也能主动选模型；迟到默认值不得覆盖已保存的手动意图。
    modelSelection: draft.modelSelectionEdited
      ? draft.modelSelection
      : (resolved.selection ?? undefined),
  };
}

/** 空 Root 草稿的旧默认值只在用户尚未明确改选时升级；正文和真实会话不走这条路。 */
export function refreshUneditedNewTaskDefaults(
  draft: V4ComposerDraft,
  view: ModelSelectionView,
  defaults?: SessionDefaults,
  recent?: ModelSelection | null,
): V4ComposerDraft {
  if (draft.modelSelectionEdited || draft.text.trim()) return draft;
  // 配置页的显式默认优先于 Recent/最高档；只更新尚未编辑的空 Root，不能覆盖用户意图。
  const current =
    !defaults?.modelSelection && draft.modelSelection
      ? resolveDraftInitialModelSelection(view, draft.modelSelection)
      : null;
  // 原因：只允许同模型 identity 刷新会挡住删除后的回退；有效自动选择继续保留，
  // 已失效的自动选择重新按本项目 Recent/Host 解析，不改变设置或用户手动选择。
  const resolved =
    current && !current.invalidated
      ? current
      : resolveDraftInitialModelSelection(view, recent ?? null, defaults?.modelSelection);
  const modelSelection = resolved.selection ?? undefined;
  // 明确审批事实已把草稿切为 yolo；重复默认刷新不能撤销用户刚同意的授权。
  const mode =
    draft.approvalModeEdited || draft.lastPermissionGrantId
      ? draft.mode
      : (defaults?.approvalMode ?? draft.mode);
  const sameModel =
    modelSelection?.providerId === draft.modelSelection?.providerId &&
    modelSelection?.modelId === draft.modelSelection?.modelId &&
    modelSelection?.options?.reasoningLevel === draft.modelSelection?.options?.reasoningLevel &&
    modelSelection?.options?.speed === draft.modelSelection?.options?.speed;
  if (sameModel && mode === draft.mode) return draft;
  return { ...draft, mode, modelSelection };
}

/** 在激活首次导入的 Session 前调用；不依赖模型可执行，也不把原新任务正文带入分享。 */
export function seedImportedSessionDraft(result: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  reused: boolean;
}): void {
  const { workspacePath, workspaceIdentity, sessionId, reused } = result;
  if (reused || readV4ComposerDraft(workspacePath, workspaceIdentity, sessionId)) return;
  const root = readV4ComposerDraft(workspacePath, workspaceIdentity, V4_DRAFT_SCOPE_ROOT);
  // 导入已创建真实 Session，旧初始化把空 snapshot 当成确定选择，跳过了新任务规则。
  // 显式标记首次导入来源，而非按“会话没模型”猜测；Root 的明确空选择也必须保留。
  persistV4ComposerDraft(
    workspacePath,
    workspaceIdentity,
    sessionId,
    root?.mode
      ? {
          text: "",
          mode: root.mode,
          planEnabled: root.planEnabled ?? false,
          modelSelection: root.modelSelection,
        }
      : { text: "", initializeFromNewTask: true },
  );
}
