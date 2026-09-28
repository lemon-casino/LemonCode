#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const ROOT = process.cwd();
const DEFAULT_OUTPUT = "dependency-graph.mmd";
const CODE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".d.ts",
  ".d.mts",
  ".d.cts",
];
const IGNORE_DIRS = new Set(["node_modules", "dist", "out", "coverage", "docs", "build"]);

function parseArgs(argv) {
  const options = {
    paths: [],
    output: DEFAULT_OUTPUT,
    format: "mermaid",
    direction: "LR",
    includeIsolated: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    // pnpm run 在透传参数时会保留一个裸 --，这里需要显式跳过，避免把它误当成待分析路径。
    if (arg === "--") {
      continue;
    }

    if (arg === "-o" || arg === "--output") {
      options.output = argv[index + 1] ?? DEFAULT_OUTPUT;
      index += 1;
      continue;
    }

    if (arg === "--format") {
      options.format = argv[index + 1] ?? "mermaid";
      index += 1;
      continue;
    }

    if (arg === "--direction") {
      options.direction = argv[index + 1] ?? "LR";
      index += 1;
      continue;
    }

    if (arg === "--include-isolated") {
      options.includeIsolated = true;
      continue;
    }

    if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    }

    options.paths.push(arg);
  }

  if (!["mermaid", "dot", "json"].includes(options.format)) {
    throw new Error(`不支持的输出格式: ${options.format}`);
  }

  if (!["LR", "RL", "TB", "TD", "BT"].includes(options.direction)) {
    throw new Error(`不支持的 Mermaid 方向: ${options.direction}`);
  }

  return options;
}

function printHelp() {
  console.log(`根据 packages 里的源码 import/export 关系生成文件级依赖图。

用法:
  pnpm dep:graph
  pnpm dep:graph -- packages/ui/src
  pnpm dep:graph -- --format json -o -

选项:
  -o, --output <path>         输出文件路径，传 - 表示输出到 stdout
  --format <mermaid|dot|json> 输出格式，默认 mermaid
  --direction <LR|RL|TB|TD|BT> Mermaid 图方向，默认 LR
  --include-isolated          把没有任何入边或出边的文件也输出出来
  -h, --help                  查看帮助
`);
}

function isCodeFile(filePath) {
  return CODE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function shouldIgnorePath(filePath) {
  const relativePath = path.relative(ROOT, filePath);
  if (relativePath.startsWith("..")) {
    return true;
  }

  const segments = relativePath.split(path.sep);
  return segments.some((segment) => IGNORE_DIRS.has(segment));
}

function walkCodeFiles(entryPath, bucket) {
  const stats = fs.statSync(entryPath);
  if (stats.isDirectory()) {
    for (const name of fs.readdirSync(entryPath)) {
      const childPath = path.join(entryPath, name);
      if (!shouldIgnorePath(childPath)) {
        walkCodeFiles(childPath, bucket);
      }
    }
    return;
  }

  if (!isCodeFile(entryPath) || shouldIgnorePath(entryPath)) {
    return;
  }

  bucket.push(path.resolve(entryPath));
}

function readJson(jsonPath) {
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

function listWorkspacePackages() {
  const packagesDir = path.join(ROOT, "packages");
  const packages = [];

  for (const name of fs.readdirSync(packagesDir)) {
    const packageRoot = path.join(packagesDir, name);
    const packageJsonPath = path.join(packageRoot, "package.json");

    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }

    const packageJson = readJson(packageJsonPath);
    packages.push({
      name: packageJson.name,
      root: packageRoot,
      srcRoot: path.join(packageRoot, "src"),
      exports: packageJson.exports ?? {},
    });
  }

  return packages;
}

function getDefaultRoots(workspacePackages) {
  return workspacePackages.map((pkg) => pkg.srcRoot).filter((srcRoot) => fs.existsSync(srcRoot));
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function ensureInsideRoot(targetPath) {
  const resolvedPath = path.resolve(targetPath);
  if (path.relative(ROOT, resolvedPath).startsWith("..")) {
    return null;
  }
  return resolvedPath;
}

function fileCandidates(basePath) {
  const normalizedBase = basePath.replace(/\\/g, "/");
  const ext = CODE_EXTENSIONS.find((candidate) => normalizedBase.endsWith(candidate));
  if (ext) {
    const stem = normalizedBase.slice(0, -ext.length);
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      return [
        normalizedBase,
        `${stem}.ts`,
        `${stem}.tsx`,
        `${stem}.mts`,
        `${stem}.cts`,
        `${stem}.d.ts`,
      ];
    }
    return [normalizedBase];
  }

  return [
    `${normalizedBase}.ts`,
    `${normalizedBase}.tsx`,
    `${normalizedBase}.mts`,
    `${normalizedBase}.cts`,
    `${normalizedBase}.js`,
    `${normalizedBase}.jsx`,
    `${normalizedBase}.mjs`,
    `${normalizedBase}.cjs`,
    `${normalizedBase}.d.ts`,
    `${normalizedBase}/index.ts`,
    `${normalizedBase}/index.tsx`,
    `${normalizedBase}/index.mts`,
    `${normalizedBase}/index.cts`,
    `${normalizedBase}/index.js`,
    `${normalizedBase}/index.jsx`,
    `${normalizedBase}/index.mjs`,
    `${normalizedBase}/index.cjs`,
    `${normalizedBase}/index.d.ts`,
  ];
}

function findExistingFile(basePath, knownFiles) {
  for (const candidate of fileCandidates(basePath)) {
    const normalizedCandidate = path.normalize(candidate);
    if (knownFiles.has(normalizedCandidate)) {
      return normalizedCandidate;
    }
  }
  return null;
}

function findOwningPackage(filePath, workspacePackages) {
  return (
    workspacePackages.find(
      (pkg) => filePath === pkg.root || filePath.startsWith(`${pkg.root}${path.sep}`),
    ) ?? null
  );
}

function extractStringExportTarget(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  for (const nestedValue of Object.values(value)) {
    const target = extractStringExportTarget(nestedValue);
    if (target) {
      return target;
    }
  }

  return null;
}

function resolveWorkspaceSpecifier(specifier, sourceFile, workspacePackages, knownFiles) {
  if (specifier.startsWith("node:")) {
    return null;
  }

  const sourcePackage = findOwningPackage(sourceFile, workspacePackages);
  if (!sourcePackage) {
    return null;
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return findExistingFile(path.resolve(path.dirname(sourceFile), specifier), knownFiles);
  }

  if (specifier.startsWith("@/")) {
    return findExistingFile(path.join(sourcePackage.srcRoot, specifier.slice(2)), knownFiles);
  }

  if (!specifier.startsWith("@lcode/")) {
    return null;
  }

  const segments = specifier.split("/");
  const packageName = segments.slice(0, 2).join("/");
  const subPath = segments.slice(2).join("/");
  const targetPackage = workspacePackages.find((pkg) => pkg.name === packageName);
  if (!targetPackage) {
    return null;
  }

  if (subPath) {
    const exportKey = `./${subPath}`;
    const exportedTarget = extractStringExportTarget(targetPackage.exports?.[exportKey]);
    if (exportedTarget) {
      const resolvedExport = ensureInsideRoot(path.join(targetPackage.root, exportedTarget));
      if (resolvedExport) {
        const existingExport = findExistingFile(resolvedExport, knownFiles);
        if (existingExport) {
          return existingExport;
        }
      }
    }

    return findExistingFile(path.join(targetPackage.srcRoot, subPath), knownFiles);
  }

  const rootExport = extractStringExportTarget(targetPackage.exports?.["."]);
  if (rootExport) {
    const resolvedExport = ensureInsideRoot(path.join(targetPackage.root, rootExport));
    if (resolvedExport) {
      const existingExport = findExistingFile(resolvedExport, knownFiles);
      if (existingExport) {
        return existingExport;
      }
    }
  }

  return findExistingFile(path.join(targetPackage.srcRoot, "index"), knownFiles);
}

function collectSpecifiers(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  const info = ts.preProcessFile(text, true, true);
  return Array.from(new Set(info.importedFiles.map((item) => item.fileName).filter(Boolean)));
}

function formatMermaid(nodes, edges, direction) {
  const ids = new Map(nodes.map((node, index) => [node, `N${index}`]));
  const lines = [`flowchart ${direction}`];

  for (const node of nodes) {
    lines.push(`    ${ids.get(node)}["${node.replaceAll('"', '\\"')}"]`);
  }

  for (const [from, to] of edges) {
    lines.push(`    ${ids.get(from)} --> ${ids.get(to)}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatDot(nodes, edges) {
  const lines = ["digraph dependencies {", '  rankdir="LR";', '  node [shape="box"];'];

  for (const node of nodes) {
    lines.push(`  "${node.replaceAll('"', '\\"')}";`);
  }

  for (const [from, to] of edges) {
    lines.push(`  "${from.replaceAll('"', '\\"')}" -> "${to.replaceAll('"', '\\"')}";`);
  }

  lines.push("}");
  return `${lines.join("\n")}\n`;
}

function formatJson(nodes, edges) {
  return `${JSON.stringify(
    {
      nodes,
      edges: edges.map(([from, to]) => ({ from, to })),
    },
    null,
    2,
  )}\n`;
}

function writeOutput(outputPath, content) {
  if (outputPath === "-") {
    process.stdout.write(content);
    return;
  }

  const absoluteOutput = path.resolve(ROOT, outputPath);
  fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
  fs.writeFileSync(absoluteOutput, content, "utf8");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const workspacePackages = listWorkspacePackages();
  const defaultRoots = getDefaultRoots(workspacePackages);
  const roots =
    options.paths.length > 0
      ? options.paths.map((entry) => path.resolve(ROOT, entry))
      : defaultRoots;

  for (const rootPath of roots) {
    if (!fs.existsSync(rootPath)) {
      throw new Error(`路径不存在: ${path.relative(ROOT, rootPath) || rootPath}`);
    }
  }

  const universeFiles = [];
  for (const rootPath of Array.from(new Set([...defaultRoots, ...roots]))) {
    if (!fs.existsSync(rootPath)) {
      continue;
    }
    walkCodeFiles(rootPath, universeFiles);
  }

  const discoveredFiles = [];
  for (const rootPath of roots) {
    walkCodeFiles(rootPath, discoveredFiles);
  }

  const uniqueFiles = Array.from(new Set(discoveredFiles)).sort();
  const knownFiles = new Set(Array.from(new Set(universeFiles)).sort());
  const edges = new Set();
  const nodes = new Set();

  for (const filePath of uniqueFiles) {
    const sourceLabel = toPosix(path.relative(ROOT, filePath));

    for (const specifier of collectSpecifiers(filePath)) {
      const resolvedFile = resolveWorkspaceSpecifier(
        specifier,
        filePath,
        workspacePackages,
        knownFiles,
      );
      if (!resolvedFile) {
        continue;
      }

      const targetLabel = toPosix(path.relative(ROOT, resolvedFile));
      nodes.add(sourceLabel);
      nodes.add(targetLabel);
      if (sourceLabel !== targetLabel) {
        edges.add(`${sourceLabel}\u0000${targetLabel}`);
      }
    }
  }

  if (options.includeIsolated) {
    for (const filePath of uniqueFiles) {
      nodes.add(toPosix(path.relative(ROOT, filePath)));
    }
  }

  const orderedNodes = Array.from(nodes).sort();
  const orderedEdges = Array.from(edges)
    .map((entry) => entry.split("\u0000"))
    .sort((left, right) => left[0].localeCompare(right[0]) || left[1].localeCompare(right[1]));

  const content =
    options.format === "json"
      ? formatJson(orderedNodes, orderedEdges)
      : options.format === "dot"
        ? formatDot(orderedNodes, orderedEdges)
        : formatMermaid(orderedNodes, orderedEdges, options.direction);

  writeOutput(options.output, content);

  const destination = options.output === "-" ? "stdout" : options.output;
  console.error(
    `已生成依赖图: ${destination} (nodes=${orderedNodes.length}, edges=${orderedEdges.length})`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
