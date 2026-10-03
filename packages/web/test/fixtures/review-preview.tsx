import { useEffect, useState } from "react";
import type { IBroadcastService } from "@lcode/services";
import { StoreProvider } from "@/store/StoreProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { PreviewPane } from "@/PreviewPane.js";
import { useReviewDiffNavigationStore } from "@/store/reviewDiffNavigationStore.js";
const broadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;

/** 使用真实 PreviewPane 及差异渲染，桩只负责现有面板的打开路由。 */
export function FixtureReviewPreview({
  onSource,
}: {
  onSource?: (source: CodeViewerSource | null) => void;
}) {
  const [source, setSource] = useState<CodeViewerSource | null>(null);
  useEffect(() => useReviewDiffNavigationStore.getState().registerPreview(setSource), []);
  onSource?.(source);
  if (!source) return null;
  return (
    <StoreProvider broadcastService={broadcastService}>
      <div className="h-[85dvh] w-full border border-border" data-testid="fixture-review-preview">
        <PreviewPane
          source={source}
          workspacePath={source.workspacePath}
          onClose={() => setSource(null)}
        />
      </div>
    </StoreProvider>
  );
}
