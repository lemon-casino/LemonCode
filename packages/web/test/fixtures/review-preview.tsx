import { lazy, Suspense, useEffect, useState, type ComponentProps } from "react";
import type { IBroadcastService } from "@lcode/services";
import { StoreProvider } from "@/store/StoreProvider.js";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import { PreviewPane } from "@/PreviewPane.js";
import { useReviewDiffNavigationStore } from "@/store/reviewDiffNavigationStore.js";
import type { FixtureReviewSidePane as ReviewSidePane } from "./review-side-pane.js";

const FixtureReviewSidePane = lazy(() =>
  import("./review-side-pane.js").then(({ FixtureReviewSidePane }) => ({
    default: FixtureReviewSidePane,
  })),
);
const broadcastService = {
  send: async () => {},
  onMessage: () => ({ dispose() {} }),
} as IBroadcastService;

export function FixtureReviewPreview({
  onSource,
  panel,
}: {
  onSource?: (source: CodeViewerSource | null) => void;
  panel?: Omit<ComponentProps<typeof ReviewSidePane>, "onSource">;
}) {
  return (
    <StoreProvider broadcastService={broadcastService}>
      {panel ? (
        <Suspense fallback={null}>
          <FixtureReviewSidePane {...panel} onSource={onSource} />
        </Suspense>
      ) : (
        <FixtureDirectPreview onSource={onSource} />
      )}
    </StoreProvider>
  );
}

/** 原独立差异场景保留轻量路由桩；工作树归属回归必须使用上面的实际面板。 */
function FixtureDirectPreview({
  onSource,
}: {
  onSource?: (source: CodeViewerSource | null) => void;
}) {
  const [source, setSource] = useState<CodeViewerSource | null>(null);
  useEffect(() => useReviewDiffNavigationStore.getState().registerPreview(setSource), []);
  onSource?.(source);
  if (!source) return null;
  return (
    <div className="h-[85dvh] w-full border border-border" data-testid="fixture-review-preview">
      <PreviewPane
        source={source}
        workspacePath={source.workspacePath}
        onClose={() => setSource(null)}
      />
    </div>
  );
}
