import type { WebFetchRedirect } from "@lcode/contracts";

export interface CachedFetchContent {
  artifactPath?: string;
  artifactUri?: string;
  bytes: number;
  content: string;
  contentType: string;
  finalUrl: string;
  redirects: WebFetchRedirect[];
  sizeBytes: number;
  status: number;
  statusText: string;
}

export interface RedirectFetchContent {
  type: "redirect";
  originalUrl: string;
  redirectUrl: string;
  redirects: WebFetchRedirect[];
  status: number;
  statusText: string;
}

export interface HttpErrorFetchContent {
  type: "http_error";
  finalUrl: string;
  originalUrl: string;
  redirects: WebFetchRedirect[];
  retryAfter?: string;
  status: number;
  statusText: string;
}

export type FetchAndExtractContentResult =
  | CachedFetchContent
  | HttpErrorFetchContent
  | RedirectFetchContent;
