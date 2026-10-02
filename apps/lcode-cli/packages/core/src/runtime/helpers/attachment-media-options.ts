import type {
  FilePartSource,
  FileSystemPort,
  ImageProcessorPort,
  SessionId,
  ToolArtifactStorePort,
  TraceContext,
  TurnAttachment,
  TurnId,
} from "../deps.js";

export interface InlineMediaResolverOptions {
  abortSignal?: AbortSignal;
  artifactStore?: ToolArtifactStorePort;
  existingArtifactUri?: string;
  imageProcessorPort?: ImageProcessorPort;
  sessionId?: SessionId;
  traceContext: TraceContext;
  turnId?: TurnId;
}

export interface LocalMediaResolverOptions extends Omit<
  InlineMediaResolverOptions,
  "existingArtifactUri"
> {
  fileSystemPort: FileSystemPort;
  workingDirectory: string;
}

export interface LocalMediaContext {
  absolutePath: string;
  attachment: TurnAttachment;
  filename: string;
  index: number;
  mime: string;
  options: LocalMediaResolverOptions;
  source: FilePartSource;
  stat: Awaited<ReturnType<FileSystemPort["stat"]>>;
}
