import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  WorkflowScriptMetaSchema,
  type FileSystemPort,
  type TraceContext,
  type WorkflowScriptMeta,
} from "@lcode/contracts";

const META_EXPORT_PATTERN = /export\s+const\s+meta\s*=/;
const META_EVAL_TIMEOUT_MS = 5_000;
const MAX_META_EVAL_OUTPUT_BYTES = 1024 * 1024;
const SCRIPT_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface WorkflowScriptDocument {
  body: string;
  content: string;
  hash: string;
  meta: WorkflowScriptMeta;
  path: string;
}

export async function readWorkflowScriptDocument(input: {
  fileSystemPort: FileSystemPort;
  scriptPath: string;
  traceContext: TraceContext;
}): Promise<WorkflowScriptDocument> {
  const scriptPath = resolve(input.scriptPath);
  const script = await input.fileSystemPort.readTextFile({
    maxBytes: SCRIPT_READ_MAX_BYTES,
    path: scriptPath,
    trace: input.traceContext,
  });
  if (script.truncated) {
    throw new Error(`Workflow script is too large: ${scriptPath}`);
  }
  const parts = extractWorkflowScriptParts(script.content);
  const expression = parts.metaExpression;
  const rawMeta = await evaluateMetaExpression(expression);
  const meta = WorkflowScriptMetaSchema.parse(rawMeta);
  return {
    body: parts.body,
    content: script.content,
    hash: stableHash(script.content),
    meta,
    path: scriptPath,
  };
}

export function stableHash(value: unknown): string {
  const content = typeof value === "string" ? value : stableStringify(value);
  return createHash("sha256").update(content).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function extractWorkflowScriptParts(source: string): {
  body: string;
  metaExpression: string;
} {
  const match = META_EXPORT_PATTERN.exec(source);
  if (!match) {
    throw new Error("Workflow script must begin with `export const meta = {...}`.");
  }
  let index = match.index + match[0].length;
  while (/\s/.test(source[index] ?? "")) index += 1;
  if (source[index] !== "{") {
    throw new Error("Workflow meta must be an object literal.");
  }

  const end = findObjectLiteralEnd(source, index);
  let bodyStart = end + 1;
  while (/\s/.test(source[bodyStart] ?? "")) bodyStart += 1;
  if (source[bodyStart] === ";") bodyStart += 1;
  return {
    body: source.slice(bodyStart).trimStart(),
    metaExpression: source.slice(index, end + 1),
  };
}

async function evaluateMetaExpression(expression: string): Promise<unknown> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", META_EVAL_SOURCE], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output: Buffer[] = [];
  const errors: Buffer[] = [];
  let outputBytes = 0;

  const timeout = setTimeout(() => child.kill(), META_EVAL_TIMEOUT_MS);
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.byteLength;
    if (outputBytes <= MAX_META_EVAL_OUTPUT_BYTES) output.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errors.push(chunk);
  });
  child.stdin.end(JSON.stringify({ expression }));

  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", resolveExit);
  });
  clearTimeout(timeout);

  const stdout = Buffer.concat(output).toString("utf8");
  const stderr = Buffer.concat(errors).toString("utf8").trim();
  if (exitCode !== 0) {
    throw new Error(stderr || `Workflow meta evaluation failed with exit code ${exitCode}`);
  }
  const result = JSON.parse(stdout) as { error?: string; ok: boolean; value?: unknown };
  if (!result.ok) throw new Error(result.error || "Workflow meta evaluation failed");
  return result.value;
}

function findObjectLiteralEnd(source: string, start: number): number {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "'" || char === '"' || char === "`") {
      index = scanString(source, index, char);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = scanLineComment(source, index + 2);
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      index = scanBlockComment(source, index + 2);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("Workflow meta object literal is not closed.");
}

function scanString(source: string, start: number, quote: string): number {
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === quote) return index;
  }
  throw new Error("Workflow meta string literal is not closed.");
}

function scanLineComment(source: string, start: number): number {
  const index = source.indexOf("\n", start);
  return index === -1 ? source.length - 1 : index;
}

function scanBlockComment(source: string, start: number): number {
  const index = source.indexOf("*/", start);
  if (index === -1) throw new Error("Workflow meta block comment is not closed.");
  return index + 1;
}

const META_EVAL_SOURCE = `
let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;
try {
  const { expression } = JSON.parse(input);
  const value = (0, eval)(\`(\${expression})\`);
  process.stdout.write(JSON.stringify({ ok: true, value }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }));
}
`;
