import { memo, useMemo } from "react";
import type { BundledTheme } from "shiki";
import {
  buildHighlightedLightweightDiffCode,
  getHighlightedLightweightDiffLine,
  HighlightedLightweightDiffPreview,
} from "@/components/ui/highlighted-lightweight-diff-preview.js";
import { inferCodeLanguage, type PatchCodeViewerSource } from "@/lib/codeViewer.js";
import { getPlainTextPatchPreviewLines } from "@/lib/patchDiffPreview.js";
import type { CodePreviewSettings } from "@/lib/codePreviewSettings.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { resolveTheme } from "@/useTheme.js";
import type { Theme } from "@/useTheme.js";

export {
  buildHighlightedLightweightDiffCode as buildInlineDiffHighlightCode,
  getHighlightedLightweightDiffLine as getInlineDiffHighlightLine,
};

function resolveInlineDiffHighlightTheme(
  theme: Theme | undefined,
  codePreviewSettings: CodePreviewSettings,
): BundledTheme {
  // theme 缺省时保持既有兜底落亮侧；否则 resolveTheme 需要 Theme 入参。
  if (theme === undefined) {
    return codePreviewSettings.lightTheme;
  }

  if (theme === "system") {
    if (typeof window !== "undefined") {
      return window.matchMedia("(prefers-color-scheme: dark)").matches
        ? codePreviewSettings.darkTheme
        : codePreviewSettings.lightTheme;
    }

    return codePreviewSettings.lightTheme;
  }

  // 非 system 主题按注册表基底归类（resolveTheme），新增深基底主题才不会漏判成亮侧。
  return resolveTheme(theme) === "dark"
    ? codePreviewSettings.darkTheme
    : codePreviewSettings.lightTheme;
}

export const EditInlineDiffContent = memo(function EditInlineDiffContent({
  preview,
  theme = "system",
  codePreviewSettings = DEFAULT_CODE_PREVIEW_SETTINGS,
}: {
  preview: PatchCodeViewerSource;
  /**
   * 应用主题（store 耦合剥离）：决定 diff 高亮取 light/dark 主题。
   * 由调用方（tool call 渲染上下文）传入；默认 "system" 跟随操作系统兜底。
   */
  theme?: Theme;
  /** 代码预览设置（store 耦合剥离）：由调用方传入，需保持引用稳定。 */
  codePreviewSettings?: CodePreviewSettings;
}) {
  const previewLines = useMemo(() => getPlainTextPatchPreviewLines(preview.patch), [preview.patch]);
  const highlightLanguage = useMemo(
    () => inferCodeLanguage(preview.path ?? preview.title, preview.patch),
    [preview.patch, preview.path, preview.title],
  );
  const highlightTheme = useMemo(
    () => resolveInlineDiffHighlightTheme(theme, codePreviewSettings),
    [codePreviewSettings, theme],
  );

  return (
    <div className="space-y-3">
      <div
        className="mb-2 max-h-60 overflow-auto rounded-xl border border-border bg-card"
        data-inline-diff-preview
      >
        {/* 聊天内联 diff 展开时直接挂载 @pierre/diffs 会把高亮和 Shadow DOM 汇总渲染压到主线程，
        导致点击展开后长时间掉帧。这里首帧只渲染轻量 hunk 文本，再在 effect 里异步补 Shiki token；
        之前只保留纯文本会让 session 里的 diff 永久失去语法高亮。 */}
        <HighlightedLightweightDiffPreview
          className="h-full bg-card"
          codePreviewSettings={codePreviewSettings}
          data-inline-diff-highlight-language={highlightLanguage}
          data-inline-diff-highlight-theme={highlightTheme}
          language={highlightLanguage}
          lines={previewLines}
          path={preview.path ?? preview.title}
          theme={highlightTheme}
        />
      </div>
    </div>
  );
});
EditInlineDiffContent.displayName = "EditInlineDiffContent";
