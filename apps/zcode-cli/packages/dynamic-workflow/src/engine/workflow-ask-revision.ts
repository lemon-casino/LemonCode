import type { WorkflowImageRef } from "./workflow-image-ref.js";

export interface WorkflowAskRevision {
  siteId: string;
  ordinal: number;
  supplement?: string;
  attachments?: WorkflowImageRef[];
}
