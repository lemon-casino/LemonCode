#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const countedExtensions = new Set([".ts", ".tsx"]);
const ignoredTestDirectories = new Set(["__tests__", "tests"]);
const ignoredTestFileSuffixes = [".spec.ts", ".spec.tsx", ".test.ts", ".test.tsx"];
const pathSeparatorPattern = /[\\/]+/u;
const ignoredWorkspacePackageDirectories = new Set(["packages/debug"]);
const ignoredDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);

const compareText = (left, right) => {
  if (left === right) {
    return 0;
  }

  return left < right ? -1 : 1;
};

const toDisplayPath = (filePath) => filePath.split(pathSeparatorPattern).join("/");

const isIgnoredWorkspacePackageDirectory = (root, directoryPath) => {
  const relativePath = toDisplayPath(relative(root, directoryPath));
  return ignoredWorkspacePackageDirectories.has(relativePath);
};

export const isTestSourceFile = (filePath) => {
  const displayPath = toDisplayPath(filePath);
  const pathSegments = displayPath.split("/");
  const fileName = pathSegments.at(-1) ?? displayPath;

  return (
    pathSegments.some((segment) => ignoredTestDirectories.has(segment)) ||
    ignoredTestFileSuffixes.some((suffix) => fileName.endsWith(suffix))
  );
};

export const countLines = (source) => {
  if (source.length === 0) {
    return 0;
  }

  const normalized = source.replaceAll("\r\n", "\n");
  const withoutFinalNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;

  if (withoutFinalNewline.length === 0) {
    return 1;
  }

  return withoutFinalNewline.split("\n").length;
};

export const isCountedSourceFile = (filePath) =>
  countedExtensions.has(extname(filePath)) && !isTestSourceFile(filePath);

export const collectTypeScriptFiles = async (rootDirectory) => {
  const root = resolve(rootDirectory);
  const files = [];

  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareText(left.name, right.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (
          !ignoredDirectories.has(entry.name) &&
          !ignoredTestDirectories.has(entry.name) &&
          !isIgnoredWorkspacePackageDirectory(root, absolutePath)
        ) {
          await walk(absolutePath);
        }
        continue;
      }

      const relativePath = toDisplayPath(relative(root, absolutePath));
      if (entry.isFile() && isCountedSourceFile(relativePath)) {
        files.push({
          absolutePath,
          relativePath,
        });
      }
    }
  };

  await walk(root);
  return files.sort((left, right) => compareText(left.relativePath, right.relativePath));
};

export const measureTypeScriptFiles = async (rootDirectory) => {
  const files = await collectTypeScriptFiles(rootDirectory);

  return Promise.all(
    files.map(async (file) => {
      const buffer = await readFile(file.absolutePath);
      const source = buffer.toString("utf8");

      return {
        ...file,
        bytes: buffer.byteLength,
        lines: countLines(source),
      };
    }),
  );
};

export const formatReport = (measurements) => {
  const sorted = [...measurements].sort((left, right) => {
    const lineDelta = right.lines - left.lines;
    if (lineDelta !== 0) {
      return lineDelta;
    }

    return compareText(left.relativePath, right.relativePath);
  });

  const totalLines = sorted.reduce((total, file) => total + file.lines, 0);
  const totalBytes = sorted.reduce((total, file) => total + file.bytes, 0);
  const lineWidth = Math.max("Lines".length, ...sorted.map((file) => String(file.lines).length));
  const byteWidth = Math.max("Bytes".length, ...sorted.map((file) => String(file.bytes).length));

  const rows = sorted.map(
    (file) =>
      `${String(file.lines).padStart(lineWidth)}  ${String(file.bytes).padStart(byteWidth)}  ${file.relativePath}`,
  );

  return (
    [
      "TypeScript file lengths (.ts, .tsx)",
      `Files: ${sorted.length}`,
      `Total lines: ${totalLines}`,
      `Total bytes: ${totalBytes}`,
      "",
      `${"Lines".padStart(lineWidth)}  ${"Bytes".padStart(byteWidth)}  File`,
      ...rows,
    ].join("\n") + "\n"
  );
};

const main = async () => {
  const [rootArgument] = process.argv.slice(2);
  const rootDirectory = rootArgument ? resolve(rootArgument) : process.cwd();
  const measurements = await measureTypeScriptFiles(rootDirectory);

  process.stdout.write(formatReport(measurements));
};

const scriptPath = fileURLToPath(import.meta.url);
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";

if (invokedPath === scriptPath) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`lint:count failed: ${message}\n`);
    process.exitCode = 1;
  });
}
