import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PdfDocumentPortError,
  READ_PDF_AVAILABILITY_TIMEOUT_MS,
  READ_PDF_INFO_TIMEOUT_MS,
  READ_PDF_MAX_PAGES_PER_REQUEST,
  READ_PDF_RENDER_TIMEOUT_MS,
  type ExecutionPort,
  type ExecutionResult,
  type PdfDocumentPageCountRequest,
  type PdfDocumentPort,
  type PdfDocumentRenderPagesRequest,
  type PdfDocumentRenderedPage,
} from "@lcode/contracts";

export interface PopplerPdfDocumentAdapterOptions {
  executionPort: ExecutionPort;
  tempRoot?: string;
}

const BROKEN_PDF_STRUCTURE_PATTERN =
  /Syntax Error(?: \(\d+\))?: Couldn't (?:find trailer dictionary|read xref table)/iu;

export function createPopplerPdfDocumentAdapter(
  options: PopplerPdfDocumentAdapterOptions,
): PdfDocumentPort {
  return new PopplerPdfDocumentAdapter(options);
}

class PopplerPdfDocumentAdapter implements PdfDocumentPort {
  private availabilityConfirmed = false;

  constructor(private readonly options: PopplerPdfDocumentAdapterOptions) {}

  async getPageCount(
    request: PdfDocumentPageCountRequest,
    options?: { signal?: AbortSignal },
  ): Promise<number | undefined> {
    const result = await this.options.executionPort.run(
      {
        command: { mode: "argv", file: "pdfinfo", args: [request.filePath] },
        timeoutMs: READ_PDF_INFO_TIMEOUT_MS,
        trace: request.trace,
      },
      options?.signal ? { signal: options.signal } : undefined,
    );
    if (result.cancelled || options?.signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF inspection was cancelled.");
    }
    if (result.status !== "completed" || result.exitCode !== 0) return undefined;
    const match = /^Pages:\s+(\d+)\s*$/imu.exec(result.stdout.text);
    const pageCount = Number(match?.[1]);
    return Number.isSafeInteger(pageCount) && pageCount >= 0 ? pageCount : undefined;
  }

  async renderPages(
    request: PdfDocumentRenderPagesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<PdfDocumentRenderedPage[]> {
    await this.ensureAvailable(request, options?.signal);
    let directory: string;
    try {
      directory = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), "lcode-read-pdf-"));
    } catch (error) {
      throwPdfIoError(
        error,
        options?.signal,
        "Unable to create a temporary directory for PDF page extraction.",
      );
    }
    const outputPrefix = join(directory, "page");
    let operationFailed = false;
    try {
      const result = await this.options.executionPort.run(
        {
          command: {
            mode: "argv",
            file: "pdftoppm",
            args: [
              "-jpeg",
              "-r",
              "100",
              "-f",
              String(request.firstPage),
              "-l",
              String(request.lastPage),
              request.filePath,
              outputPrefix,
            ],
          },
          timeoutMs: READ_PDF_RENDER_TIMEOUT_MS,
          trace: request.trace,
        },
        options?.signal ? { signal: options.signal } : undefined,
      );
      assertRenderSucceeded(result, request);
      return await readRenderedPages(directory, options?.signal);
    } catch (error) {
      operationFailed = true;
      throw error;
    } finally {
      try {
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        // 根因：清理错误覆盖主错误会丢失已经完成的 Poppler 稳定分类；仅当主流程
        // 成功时把清理失败暴露为 I/O 错误，失败路径继续保留原始原因。
        if (!operationFailed) {
          throwPdfIoError(error, options?.signal, "Unable to remove temporary PDF page images.");
        }
      }
    }
  }

  private async ensureAvailable(
    request: PdfDocumentPageCountRequest,
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.availabilityConfirmed) return;
    const result = await this.options.executionPort.run(
      {
        command: { mode: "argv", file: "pdftoppm", args: ["-v"] },
        timeoutMs: READ_PDF_AVAILABILITY_TIMEOUT_MS,
        trace: request.trace,
      },
      signal ? { signal } : undefined,
    );
    if (result.cancelled || signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.");
    }
    if (result.timedOut || result.status === "timed_out") {
      // 根因：可用性探测超时表示命令已启动但未及时响应，不等于缺少 Poppler。
      throw new PdfDocumentPortError(
        "timeout",
        `PDF page extraction availability check timed out after ${READ_PDF_AVAILABILITY_TIMEOUT_MS}ms.`,
      );
    }
    if (!isAvailableProbeResult(result)) {
      throw new PdfDocumentPortError(
        "unavailable",
        "pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.",
        { cause: result.error?.cause },
      );
    }
    // 失败结果不能缓存；用户安装 Poppler 后同一进程应能立即恢复。
    this.availabilityConfirmed = true;
  }
}

function assertRenderSucceeded(
  result: ExecutionResult,
  request: PdfDocumentRenderPagesRequest,
): void {
  if (result.cancelled) {
    throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.");
  }
  if (result.timedOut || result.status === "timed_out") {
    throw new PdfDocumentPortError(
      "timeout",
      `PDF page extraction timed out after ${READ_PDF_RENDER_TIMEOUT_MS}ms.`,
    );
  }
  if (result.status === "completed" && result.exitCode === 0) return;

  const stderr = result.stderr.text;
  const detail = [stderr, result.stdout.text, result.error?.message]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  if (/password/iu.test(stderr)) {
    throw new PdfDocumentPortError(
      "password_protected",
      "PDF is password-protected. Please provide an unprotected version.",
    );
  }
  const pageRangeMatch = /Wrong page range given[\s\S]*last page \((\d+)\)/iu.exec(stderr);
  if (pageRangeMatch) {
    const documentPageCount = Number(pageRangeMatch[1]);
    if (documentPageCount === 0) {
      throw new PdfDocumentPortError(
        "corrupted",
        "PDF reports 0 pages (empty page tree). The PDF may be invalid.",
      );
    }
    if (Number.isSafeInteger(documentPageCount) && documentPageCount >= 1) {
      const requestedRange =
        request.firstPage === request.lastPage
          ? `page ${request.firstPage}`
          : `pages ${request.firstPage}-${request.lastPage}`;
      const exampleEnd = Math.min(documentPageCount, READ_PDF_MAX_PAGES_PER_REQUEST);
      throw new PdfDocumentPortError(
        "page_out_of_range",
        `Requested ${requestedRange} is outside the document (PDF has ${documentPageCount} page${documentPageCount === 1 ? "" : "s"}). Use a range within 1-${documentPageCount}, maximum ${READ_PDF_MAX_PAGES_PER_REQUEST} pages per request (e.g. pages: "1-${exampleEnd}").`,
      );
    }
  }
  const diagnosticLines = stderr.split("\n");
  const firstDiagnostic = diagnosticLines[0] ?? "";
  const hasCommandOrInternalError = diagnosticLines.some((line) =>
    /^(?:Command Line Error|Internal Error)(?: \(\d+\))?: /u.test(line),
  );
  const isInputIoError =
    firstDiagnostic.startsWith("I/O Error: ") && firstDiagnostic.includes(`'${request.filePath}'`);
  const isInputPermissionError = firstDiagnostic.startsWith("Permission Error: ");
  if ((isInputIoError || isInputPermissionError) && !hasCommandOrInternalError) {
    // 落入 process_failed，避免用宽泛关键词猜测错误类别。
    throw new PdfDocumentPortError(
      isInputPermissionError ? "permission_denied" : "io_error",
      `Could not render PDF: ${firstDiagnostic}`,
    );
  }
  // 根因：宽泛匹配 detail 会把文件名和无关诊断误判成密码、权限或损坏错误；
  // 这里只解析已知的 Poppler stderr，其余失败保留为 process_failed。
  if (/damaged|corrupt|invalid/iu.test(stderr) || BROKEN_PDF_STRUCTURE_PATTERN.test(stderr)) {
    throw new PdfDocumentPortError("corrupted", "PDF file is corrupted or invalid.");
  }
  throw new PdfDocumentPortError(
    "process_failed",
    detail.length > 0 ? `pdftoppm failed: ${detail}` : "pdftoppm failed.",
    { cause: result.error?.cause },
  );
}

async function readRenderedPages(
  directory: string,
  signal?: AbortSignal,
): Promise<PdfDocumentRenderedPage[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    throwPdfIoError(error, signal, "Unable to list rendered PDF page images.");
  }
  const files = names
    .map((name) => ({ name, pageNumber: renderedPageNumber(name) }))
    .filter(
      (entry): entry is { name: string; pageNumber: number } => entry.pageNumber !== undefined,
    )
    .sort((left, right) => left.pageNumber - right.pageNumber);
  if (files.length === 0) {
    throw new PdfDocumentPortError(
      "corrupted",
      "pdftoppm produced no output pages. The PDF may be invalid.",
    );
  }
  try {
    return await Promise.all(
      files.map(async ({ name, pageNumber }) => ({
        data: new Uint8Array(
          await readFile(join(directory, name), signal === undefined ? undefined : { signal }),
        ),
        mediaType: "image/jpeg" as const,
        pageNumber,
      })),
    );
  } catch (error) {
    if (signal?.aborted) {
      throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
        cause: error,
      });
    }
    throw new PdfDocumentPortError("io_error", "Unable to read rendered PDF page images.", {
      cause: error,
    });
  }
}

function isAvailableProbeResult(result: ExecutionResult): boolean {
  if (result.status !== "completed" && result.status !== "failed") return false;
  return (
    result.exitCode === 0 ||
    (result.exitCode !== undefined && result.exitCode !== 127 && result.stderr.text.length > 0)
  );
}

function throwPdfIoError(error: unknown, signal: AbortSignal | undefined, message: string): never {
  if (signal?.aborted) {
    throw new PdfDocumentPortError("cancelled", "PDF page extraction was cancelled.", {
      cause: error,
    });
  }
  throw new PdfDocumentPortError("io_error", message, { cause: error });
}

function renderedPageNumber(name: string): number | undefined {
  const match = /-(\d+)\.jpg$/iu.exec(name);
  const pageNumber = Number(match?.[1]);
  return Number.isSafeInteger(pageNumber) && pageNumber >= 1 ? pageNumber : undefined;
}
