import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeDerivedTrajectories } from "./derive.js";
import { writeModelIoAnthropicTrajectory } from "./model-io.js";
import { recordPromptTrajectory, recordPromptTrajectoryFromFixture } from "./record.js";
import {
  createTimestampedPromptDirectory,
  promptFixtureFromText,
  type SharedModelOptions,
} from "./prompt.js";

interface CliOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  referenceRequestPath?: string;
  fixturePath?: string;
  inputPath?: string;
  modelId?: string;
  outDir?: string;
  outRoot?: string;
  prompt?: string;
  promptFile?: string;
  querySource?: string;
  upstreamBaseURL?: string;
}

const command = process.argv[2];
const options = parseOptions(process.argv.slice(3));

try {
  if (command === "record") {
    requireOption(options.fixturePath, "--fixture");
    requireOption(options.outDir, "--out");
    await recordPromptTrajectory({
      referenceRequestPath: options.referenceRequestPath,
      fixturePath: options.fixturePath,
      outDir: options.outDir,
    });
  } else if (command === "record-prompt") {
    const prompt = await readPrompt(options);
    const outDir =
      options.outDir ?? (await createTimestampedPromptDirectory(options.outRoot ?? "out"));
    await recordPromptTrajectoryFromFixture({
      referenceRequestPath: options.referenceRequestPath,
      fixture: promptFixtureFromText({
        modelOptions: readModelOptions(options),
        name: "command-line-prompt",
        prompt,
      }),
      outDir,
    });
    console.log(`Recorded prompt trajectory into ${outDir}`);
  } else if (command === "derive") {
    requireOption(options.outDir, "--out");
    await writeDerivedTrajectories({
      referenceRequestPath: options.referenceRequestPath,
      inputPath: options.inputPath ?? join(options.outDir, "trajectory.jsonl"),
      outDir: options.outDir,
    });
  } else if (command === "model-io") {
    requireOption(options.inputPath, "--input");
    requireOption(options.outDir, "--out");
    await writeModelIoAnthropicTrajectory({
      inputPath: options.inputPath,
      outDir: options.outDir,
      querySource: options.querySource,
    });
    console.log(`Converted model-io JSONL into ${join(options.outDir, "anthropic_trajectory.json")}`);
  } else {
    printUsageAndExit();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}

function parseOptions(args: readonly string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") continue;
    const readValue = (): string => {
      const value = args[index + 1];
      if (!value) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--fixture") {
      options.fixturePath = readValue();
    } else if (arg === "--prompt") {
      options.prompt = readValue();
    } else if (arg === "--prompt-file") {
      options.promptFile = readValue();
    } else if (arg === "--out") {
      options.outDir = readValue();
    } else if (arg === "--out-root") {
      options.outRoot = readValue();
    } else if (arg === "--input") {
      options.inputPath = readValue();
    } else if (arg === "--reference-request") {
      options.referenceRequestPath = readValue();
    } else if (arg === "--query-source") {
      options.querySource = readValue();
    } else if (arg === "--model") {
      options.modelId = readValue();
    } else if (arg === "--upstream-base-url" || arg === "--base-url") {
      options.upstreamBaseURL = readValue();
    } else if (arg === "--api-key-env") {
      options.apiKeyEnv = readValue();
    } else if (arg === "--api-key") {
      options.apiKey = readValue();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireOption<T>(value: T | undefined, flag: string): asserts value is T {
  if (value === undefined || value === "") {
    throw new Error(`Missing required option ${flag}`);
  }
}

async function readPrompt(options: CliOptions): Promise<string> {
  if (options.prompt !== undefined && options.promptFile !== undefined) {
    throw new Error("Use only one of --prompt or --prompt-file.");
  }
  if (options.prompt !== undefined) return options.prompt;
  requireOption(options.promptFile, "--prompt-file");
  return readFile(options.promptFile, "utf8");
}

function readModelOptions(options: CliOptions): SharedModelOptions {
  if (
    options.apiKey === undefined &&
    options.apiKeyEnv === undefined &&
    options.modelId === undefined &&
    options.upstreamBaseURL === undefined
  ) {
    return {};
  }
  return {
    apiKey: options.apiKey,
    apiKeyEnv: options.apiKeyEnv,
    modelId: options.modelId,
    upstreamBaseURL: options.upstreamBaseURL,
  };
}

function printUsageAndExit(): never {
  console.error(`Usage:
  pnpm --filter @lcode/prompt-trajectory record -- --fixture <fixture.json> --out <dir> [--reference-request <path>]
  pnpm --filter @lcode/prompt-trajectory record:prompt -- --prompt <text> --model <provider/model> --upstream-base-url <url> [--out <dir>] [--api-key-env <env>]
  pnpm --filter @lcode/prompt-trajectory derive -- --out <dir> [--input <trajectory.jsonl>] [--reference-request <path>]
  pnpm --filter @lcode/prompt-trajectory model-io -- --input <model-io.jsonl> --out <dir> [--query-source main_turn]`);
  process.exit(1);
}
