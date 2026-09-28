#!/usr/bin/env node

import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { writeNativeSearchProducerBundleMeta } from "./native-search-tools-bundle-meta.mjs";
import {
  normalizeNativeSearchPlatform,
  resolveNativeSearchPrebuiltPlan,
} from "./native-search-tools-config.mjs";
import { buildNativeSearchToolsUnix } from "./native-search-tools-unix.mjs";
import { buildNativeSearchToolsWindows } from "./native-search-tools-windows.mjs";

const scriptPath = fileURLToPath(import.meta.url);

function fail(message) {
  throw new Error(message);
}

export function buildNativeSearchTools(options = {}) {
  const platform = normalizeNativeSearchPlatform(options.platform ?? process.platform);
  let plan;
  switch (platform) {
    case "darwin":
    case "linux":
      plan = buildNativeSearchToolsUnix({ ...options, platform });
      break;
    case "win32":
      plan = buildNativeSearchToolsWindows({ ...options, platform });
      break;
  }

  writeNativeSearchProducerBundleMeta(
    resolveNativeSearchPrebuiltPlan({
      arch: plan.arch,
      outputDir: plan.outputDir,
      platform: plan.platform,
    }),
  );
  return plan;
}

function readOption(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function readJobs() {
  const rawJobs = readOption("jobs");
  if (rawJobs === undefined) {
    return undefined;
  }
  const jobs = Number.parseInt(rawJobs, 10);
  if (!Number.isInteger(jobs) || jobs < 1) {
    fail(`invalid --jobs value: ${rawJobs}`);
  }
  return jobs;
}

function main() {
  const options = {
    platform: readOption("platform") ?? process.env.LCODE_TARGET_OS ?? process.platform,
    arch: readOption("arch") ?? process.env.LCODE_TARGET_ARCH ?? process.arch,
    outputDir: readOption("output-dir"),
    keepWorkdir: hasFlag("keep-workdir"),
    quiet: hasFlag("quiet"),
    runUpstreamTests: hasFlag("run-upstream-tests"),
  };
  const jobs = readJobs();
  if (jobs !== undefined) {
    options.jobs = jobs;
  }
  buildNativeSearchTools(options);
}

if (resolve(process.argv[1] ?? "") === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  }
}
