import type { ReactNode } from "react";
import { TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON } from "@lcode/shared";
import type { ModelProviderNavGroup } from "@/settings/model-provider-section/constants.js";
import { ModelProviderSectionNavigation } from "@/settings/model-provider-section/Navigation.js";
import { ProviderDetailFeedbackBoundary } from "@/settings/model-provider-section/ProviderDetailFeedback.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";

interface ModelProviderSectionLayoutProps {
  description: string;
  refreshLabel: string;
  loadingLabel: string;
  presetLoading: boolean;
  customLoading: boolean;
  onRefresh: () => void;
  addProviderLabel: string;
  onAddProvider: () => void;
  navigationGroups: ModelProviderNavGroup[];
  selectedNodeKey: string | null;
  onSelectNavItem: (item: ModelProviderNavGroup["items"][number]) => void;
  onReorderProviderIds?: (providerIds: string[]) => Promise<void>;
  reorderableProviderIds?: ReadonlySet<string>;
  children: ReactNode;
}

function shouldShowModelProviderRefreshLoading(params: {
  presetLoading: boolean;
  customLoading: boolean;
}): boolean {
  return params.presetLoading || params.customLoading;
}

export function ModelProviderSectionLayout({
  description,
  refreshLabel,
  loadingLabel,
  presetLoading,
  customLoading,
  onRefresh,
  addProviderLabel,
  onAddProvider,
  navigationGroups,
  selectedNodeKey,
  onSelectNavItem,
  onReorderProviderIds,
  reorderableProviderIds,
  children,
}: ModelProviderSectionLayoutProps) {
  const refreshButtonLoading = shouldShowModelProviderRefreshLoading({
    presetLoading,
    customLoading,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-ui-base leading-6 text-foreground-subtle">{description}</p>
        <SettingsResourceHeaderActions
          onRefresh={onRefresh}
          onNew={onAddProvider}
          refreshing={refreshButtonLoading}
          refreshLabel={refreshButtonLoading ? loadingLabel : refreshLabel}
          newLabel={addProviderLabel}
          newTestId={TID_MODEL_PROVIDER_ADD_PROVIDER_BUTTON}
        />
      </div>

      <div className="overflow-clip rounded-xl border border-border bg-card">
        <div
          // 仅设最小高度会让长列表撑高整页；固定分栏高度并允许子项收缩，滚动由各栏独立承接。
          className="grid h-[min(36rem,calc(100dvh-12rem))] min-h-0 grid-cols-[56px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] gap-0 md:grid-cols-[224px_minmax(0,1fr)]"
          data-model-provider-split-panel="true"
        >
          <div
            className="min-h-0 min-w-0 overflow-y-auto overscroll-y-contain border-r border-border"
            data-model-provider-navigation-scroll="true"
            tabIndex={0}
          >
            <ModelProviderSectionNavigation
              navigationGroups={navigationGroups}
              selectedNodeKey={selectedNodeKey}
              presetLoading={presetLoading}
              customLoading={customLoading}
              onSelectNavItem={onSelectNavItem}
              onReorderProviderIds={onReorderProviderIds}
              reorderableProviderIds={reorderableProviderIds}
            />
          </div>
          <div className="relative min-h-0 min-w-0">
            <ProviderDetailFeedbackBoundary key={selectedNodeKey ?? "unselected-provider"}>
              {/* 反馈层与内容滚动容器同级，避免内部滚动把反馈带出可见区域。 */}
              <div
                className="h-full min-h-0 min-w-0 overflow-y-auto overscroll-y-contain p-4 pb-20 sm:p-6 sm:pb-24"
                data-model-provider-detail-scroll="true"
                tabIndex={0}
              >
                {children}
              </div>
            </ProviderDetailFeedbackBoundary>
          </div>
        </div>
      </div>
    </div>
  );
}
