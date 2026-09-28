#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "../../../scripts/spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(scriptDir, "..");
const workspaceRoot = resolve(desktopRoot, "../..");
const sourceRoot = resolve(desktopRoot, "native/windows-browser-import-helper");
const targetArch = (process.env.LCODE_TARGET_ARCH ?? arch()).toLowerCase();
const targetKey = `win32-${targetArch}`;
const outputDir = resolve(desktopRoot, `bundled-tools/${targetKey}/browser-import`);
const outputPath = resolve(outputDir, "lcode-browser-import-helper.exe");
const generatedAssemblyInfoPath = resolve(outputDir, "BrowserImportAssemblyInfo.g.cs");
const appVersion = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8")).version;
const buildCommit = (
  process.env.LCODE_COMMIT ??
  execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  })
).trim();
const cscCandidates = [
  process.env.LCODE_CSC_PATH,
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
].filter(Boolean);
const cscPath = cscCandidates.find((candidate) => existsSync(candidate));

if (platform() !== "win32") {
  console.log("[browser-import-helper] skip: Windows helper is built only on Windows");
  process.exit(0);
}
if (targetArch !== "x64" && targetArch !== "arm64") {
  throw new Error(`Unsupported Windows browser import helper architecture: ${targetArch}`);
}
if (targetArch === "arm64" && !process.env.LCODE_CSC_PATH) {
  throw new Error(
    "Windows arm64 browser import helper requires LCODE_CSC_PATH pointing to an arm64-capable Roslyn csc.exe",
  );
}
if (!cscPath) {
  throw new Error("Windows C# compiler not found; set LCODE_CSC_PATH to a trusted csc.exe");
}

mkdirSync(outputDir, { recursive: true });
rmSync(outputPath, { force: true });
const numericVersion = appVersion.split("-", 1)[0].split(".");
while (numericVersion.length < 4) numericVersion.push("0");
if (
  !/^\d+(?:\.\d+){2}(?:-[0-9A-Za-z.-]+)?$/.test(appVersion) ||
  !/^[0-9A-Za-z.-]+$/.test(buildCommit) ||
  numericVersion.some((part) => !/^\d+$/.test(part))
) {
  throw new Error("Invalid Windows browser import helper build identity");
}
writeFileSync(
  generatedAssemblyInfoPath,
  [
    "using System.Reflection;",
    `[assembly: AssemblyVersion("${numericVersion.slice(0, 4).join(".")}")]`,
    `[assembly: AssemblyFileVersion("${numericVersion.slice(0, 4).join(".")}")]`,
    `[assembly: AssemblyInformationalVersion("${appVersion}|${buildCommit}")]`,
    "",
  ].join("\n"),
  "utf8",
);
try {
  runCommand(cscPath, [
    "/nologo",
    "/optimize+",
    "/target:exe",
    `/platform:${targetArch}`,
    `/win32manifest:${resolve(sourceRoot, "app.manifest")}`,
    "/reference:System.Core.dll",
    "/reference:System.Numerics.dll",
    `/out:${outputPath}`,
    resolve(sourceRoot, "Program.cs"),
    generatedAssemblyInfoPath,
  ]);
} finally {
  rmSync(generatedAssemblyInfoPath, { force: true });
}
console.log(`[browser-import-helper] built ${outputPath}`);
