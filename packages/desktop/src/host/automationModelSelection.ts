import type { ModelSelection } from "@lcode/shared";
import type { IModelSelectionService } from "@lcode/services";

/** 在 Automation Select 转为一次 Submission 的边界固定模型身份。 */
export async function resolveAutomationSubmissionModelSelection(params: {
  selection?: ModelSelection;
  fixedSelection?: ModelSelection;
  readSelection?: () => Promise<ModelSelection | undefined>;
  modelSelectionService: Pick<IModelSelectionService, "getView">;
}): Promise<ModelSelection> {
  // 已固定 run 是执行事实；重试不能重新对应账号，更不能被当前读取失败改变。
  if (params.fixedSelection) return params.fixedSelection;
  // Scheduler 的快照可能早于 Host 单向导入；首次执行用持久层校验后的新版意图。
  const selection = params.readSelection ? await params.readSelection() : params.selection;
  if (selection) {
    const view = await params.modelSelectionService.getView({ selection });
    if (view.selectionIssue || !view.effectiveSelection?.options?.reasoningLevel) {
      throw new Error("Automation 模型选择不可用，请重新选择模型与思考档位");
    }
    return view.effectiveSelection;
  }

  const preferredSelection = (await params.modelSelectionService.getView()).preferredSelection;
  if (!preferredSelection?.options?.reasoningLevel) {
    throw new Error("Automation 无法从目标 Host 解析首选模型");
  }
  return preferredSelection;
}
