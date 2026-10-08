import type { IPlatformService } from "@lcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { runExportLogsAction } from "@/lib/exportLogsAction.js";
import { LCODE_PRODUCT_DOCS_URL } from "@/lib/productDocs.js";

interface HelpMenuActionHandlers {
  openProductDocs: () => void;
  exportLogs: () => void;
}

export function createHelpMenuActionHandlers({
  platform,
  intl,
}: {
  platform: Pick<IPlatformService, "captureWindowScreenshot" | "exportLogs" | "openExternal">;
  intl: IntlInstance;
}): HelpMenuActionHandlers {
  return {
    openProductDocs: () => {
      platform.openExternal(LCODE_PRODUCT_DOCS_URL);
    },
    exportLogs: () => {
      void runExportLogsAction(platform, intl);
    },
  };
}
