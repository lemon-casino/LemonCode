import type { TraceContext } from "../tracing/tracer.js";

export interface PdfDocumentPageCountRequest {
  filePath: string;
  trace: TraceContext;
}

export interface PdfDocumentRenderPagesRequest extends PdfDocumentPageCountRequest {
  firstPage: number;
  lastPage: number;
}

export interface PdfDocumentRenderedPage {
  data: Uint8Array;
  mediaType: "image/jpeg";
  pageNumber: number;
}

export type PdfDocumentErrorCode =
  | "cancelled"
  | "corrupted"
  | "io_error"
  | "page_out_of_range"
  | "password_protected"
  | "permission_denied"
  | "process_failed"
  | "timeout"
  | "unavailable";

export class PdfDocumentPortError extends Error {
  constructor(
    readonly code: PdfDocumentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PdfDocumentPortError";
  }
}

export interface PdfDocumentPort {
  getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined>;
  renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]>;
}
