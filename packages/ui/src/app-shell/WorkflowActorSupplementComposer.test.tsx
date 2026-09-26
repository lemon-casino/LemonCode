import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComposerAttachmentUploadItem } from "@/store/composerAttachmentUploadStore.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

// Node 的源码测试不经过 Vite；为共享编辑器的插件图标提供等价 URL 模块，避免把构建器细节带进布局断言。
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith("/LexicalChatInput.tsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import React from "react";
          export function LexicalChatInput({
            enableMentionPanel,
            enableSlashPanel,
            enterSubmits,
            inputTestId,
            onModifiedSubmit,
          }) {
            return React.createElement("div", {
              "data-enable-mention-panel": String(enableMentionPanel),
              "data-enable-slash-panel": String(enableSlashPanel),
              "data-enter-submits": String(enterSubmits),
              "data-has-modified-submit": String(Boolean(onModifiedSubmit)),
              "data-testid": inputTestId,
            });
          }
        `,
      };
    }
    if (url.endsWith("/prompt-editor/ChatPromptActionMenu.tsx")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import React from "react";
          export function ChatPromptActionMenu({ showPlugins, showQuickCommands }) {
            return React.createElement(
              "button",
              {
                "data-show-plugins": String(showPlugins),
                "data-show-quick-commands": String(showQuickCommands),
                type: "button",
              },
              "+",
            );
          }
        `,
      };
    }
    if (/\.(?:gif|jpe?g|png|webp)$/.test(url)) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(url)};`,
      };
    }
    return nextLoad(url, context);
  },
});

const { WorkflowActorSupplementComposer } = await import("./WorkflowActorSupplementComposer.js");

const readyImage: ComposerAttachmentUploadItem = {
  id: "image-1",
  filename: "evidence.png",
  mimeType: "image/png",
  sizeBytes: 128,
  objectUrl: "data:image/png;base64,AA==",
  referenceOwnership: "composer",
  uploadStatus: "ready",
  uploadProgress: 100,
  operationId: "upload-1",
  autoRetryCount: 0,
  runtimeRebuildRetryCount: 0,
  staged: true,
  adopted: false,
  showComplete: false,
  localZeroCopy: false,
};

test("actor image thumbnail is rendered inside the shared prompt editor shell", () => {
  const markup = renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="zh-CN">
      <TooltipProvider>
        <TabStoreProvider>
          <WorkflowActorSupplementComposer
            attachments={[readyImage]}
            attachmentError={null}
            canSubmit
            disabled={false}
            draftKey="run-1:ask-1@1"
            inputApiRef={{ current: null }}
            onAddImage={() => undefined}
            onChange={() => undefined}
            onPaste={() => undefined}
            onRemoveImage={() => undefined}
            onRetryImage={() => undefined}
            onSubmit={() => false}
            parentSessionId="session-1"
            pending={false}
            value="adjust the result"
            workspacePath="C:/workspace"
          />
        </TabStoreProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>,
  );

  const shellStart = markup.indexOf('data-testid="workflow-actor-composer-shell"');
  const thumbnail = markup.indexOf('data-workflow-actor-image="image-1"');
  const editor = markup.indexOf('data-testid="workflow-actor-supplement"');

  assert.ok(shellStart >= 0);
  assert.ok(thumbnail > shellStart);
  assert.ok(editor > thumbnail);
  assert.match(markup, /<img[^>]+evidence\.png/);
  assert.match(markup, /data-enable-mention-panel="false"/);
  assert.match(markup, /data-enable-slash-panel="false"/);
  assert.match(markup, /data-enter-submits="false"/);
  assert.match(markup, /data-has-modified-submit="true"/);
  assert.match(markup, /data-show-plugins="false"/);
  assert.match(markup, /data-show-quick-commands="false"/);
});
