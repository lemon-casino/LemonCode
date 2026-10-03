import {
  useDraftExecutionStore,
  type DraftExecutionSelection,
} from "@/store/draftExecutionStore.js";
import { useWorktreePreparation } from "@/hooks/useWorktreePreparation.js";
import { ConversationUserInputBody } from "@/v4/ConversationUserInputBody.js";
import { ConversationUserInputContent } from "@/v4/ConversationUserInputContent.js";
import { parseComposerPromptContexts } from "@/v4/composer/composerPromptContexts.js";
import { DraftWorktreePreparation } from "./DraftWorktreePreparation.js";
import { WorktreePreparationCard } from "./WorktreePreparationCard.js";

export function hasDraftWorktreePreparation(draft: DraftExecutionSelection | undefined): boolean {
  return draft?.mode === "worktree" && Boolean(draft.requestId || draft.creationEnvelope);
}

export function DraftWorktreeConversation({
  workspacePath,
  workspaceIdentity,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const scope = workspaceIdentity?.trim() || workspacePath;
  const draft = useDraftExecutionStore((state) => state.drafts[scope]);
  if (!hasDraftWorktreePreparation(draft)) return null;
  const input = (draft?.creationEnvelope?.payload as { firstInput?: { text?: string } } | undefined)
    ?.firstInput;
  const { visibleContent } = parseComposerPromptContexts(input?.text ?? "", {
    workspacePath,
    workspaceIdentity,
  });
  return (
    <section
      className="min-w-0 space-y-5 px-4 pt-8 pb-5 @md/conversation:px-6"
      data-testid="draft-worktree-conversation"
    >
      {visibleContent ? (
        // 原因：准备期间还没有 CLI 消息。预览只读冻结输入，不生成假 row 或历史操作。
        <div className="flex min-w-0 flex-col items-end" data-testid="worktree-pending-input">
          <div className="flex max-w-full flex-col rounded-xl rounded-tr-xs border border-border bg-surface px-4 py-3 text-ui-base text-foreground @min-[624px]/conversation:max-w-xl">
            <ConversationUserInputBody
              key={draft?.creationEnvelope?.commandId}
              contentText={visibleContent}
              rowId={0}
            >
              <ConversationUserInputContent text={visibleContent} />
            </ConversationUserInputBody>
          </div>
        </div>
      ) : null}
      <DraftWorktreePreparation
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
      />
    </section>
  );
}

export function SessionWorktreePreparation({
  workspacePath,
  workspaceIdentity,
  sessionId,
}: {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
}) {
  const state = useWorktreePreparation(workspacePath, workspaceIdentity, undefined, sessionId);
  // 同目录分叉解析到父绑定，父工作树的创建过程不能冒充本会话的创建过程。
  if (state.binding?.taskId !== sessionId || !state.binding.preparation) return null;
  return <WorktreePreparationCard binding={state.binding} error={state.error} />;
}
