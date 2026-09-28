// ============================================================
// Read PDF Contract
// ============================================================

export const READ_PDF_NATIVE_MAX_INPUT_BYTES = 20 * 1024 * 1024;
export const READ_PDF_EXTRACT_MAX_INPUT_BYTES = 100 * 1024 * 1024;
export const READ_PDF_NATIVE_MAX_PAGES = 10;
export const READ_PDF_MAX_PAGES_PER_REQUEST = 20;
export const READ_PDF_INFO_TIMEOUT_MS = 10_000;
export const READ_PDF_AVAILABILITY_TIMEOUT_MS = 5_000;
export const READ_PDF_RENDER_TIMEOUT_MS = 120_000;
export const READ_PDF_PAGES_DESCRIPTION =
  'Page range for PDF files (e.g., "1-5", "3", "10-20"). Only applicable to PDF files. Maximum 20 pages per request.';

export const ReadErrorCode = {
  PDF_INVALID_PAGES: 7,
  PDF_PAGE_RANGE_TOO_LARGE: 8,
  PDF_PAGES_IMAGES_UNSUPPORTED: 10,
  PDF_CONFIGURATION_ERROR: 11,
  PDF_INVALID: 12,
  PDF_TOO_LARGE: 13,
  PDF_TOO_MANY_PAGES: 14,
  PDF_TIMEOUT: 15,
  PDF_PASSWORD_PROTECTED: 16,
  PDF_PAGE_OUT_OF_RANGE: 17,
  PDF_PERMISSION_DENIED: 18,
  PDF_IO_ERROR: 19,
  PDF_PROCESS_FAILED: 20,
} as const;

export type ReadErrorCode = (typeof ReadErrorCode)[keyof typeof ReadErrorCode];

export interface ReadPdfPageRange {
  firstPage: number;
  lastPage: number;
}

export interface ReadPdfPagesValidationFailure {
  errorCode: typeof ReadErrorCode.PDF_INVALID_PAGES | typeof ReadErrorCode.PDF_PAGE_RANGE_TOO_LARGE;
  message: string;
}

export function parseReadPdfPageRange(value: string): ReadPdfPageRange | undefined {
  const normalized = value.trim();
  if (/^\d+-$/u.test(normalized)) {
    const firstPage = Number(normalized.slice(0, -1));
    return Number.isSafeInteger(firstPage) && firstPage >= 1
      ? { firstPage, lastPage: Number.POSITIVE_INFINITY }
      : undefined;
  }
  const match = /^(\d+)(?:-(\d+))?$/u.exec(normalized);
  if (!match) return undefined;
  const firstPage = Number(match[1]);
  const lastPage = Number(match[2] ?? match[1]);
  if (
    !Number.isSafeInteger(firstPage) ||
    !Number.isSafeInteger(lastPage) ||
    firstPage < 1 ||
    lastPage < firstPage
  ) {
    return undefined;
  }
  return { firstPage, lastPage };
}

function readPdfPageCount(range: ReadPdfPageRange): number {
  return range.lastPage === Number.POSITIVE_INFINITY
    ? READ_PDF_MAX_PAGES_PER_REQUEST + 1
    : range.lastPage - range.firstPage + 1;
}

export function getReadPdfPagesValidationFailure(
  filePath: string,
  pages: string | undefined,
): ReadPdfPagesValidationFailure | undefined {
  if (pages === undefined || !filePath.toLowerCase().endsWith(".pdf")) return undefined;

  const range = parseReadPdfPageRange(pages);
  if (!range) {
    return {
      errorCode: ReadErrorCode.PDF_INVALID_PAGES,
      message: `Invalid pages parameter: "${pages}". Use formats like "1-5", "3", or "10-20". Pages are 1-indexed.`,
    };
  }
  if (readPdfPageCount(range) > READ_PDF_MAX_PAGES_PER_REQUEST) {
    return {
      errorCode: ReadErrorCode.PDF_PAGE_RANGE_TOO_LARGE,
      message: `Page range "${pages}" exceeds maximum of ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request. Please use a smaller range.`,
    };
  }
  return undefined;
}
