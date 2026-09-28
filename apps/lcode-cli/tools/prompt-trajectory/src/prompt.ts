import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PromptTrajectoryFixture } from "./fixture.js";

export interface SharedModelOptions {
  apiKey?: string;
  apiKeyEnv?: string;
  modelId?: string;
  upstreamBaseURL?: string;
}

export async function createTimestampedPromptDirectory(
  outRoot: string,
  now = new Date(),
): Promise<string> {
  const directory = join(outRoot, `prompt${formatTimestamp(now)}`);
  await mkdir(directory, { recursive: true });
  return directory;
}

export function promptFixtureFromText(input: {
  modelOptions?: SharedModelOptions;
  name: string;
  prompt: string;
}): PromptTrajectoryFixture {
  const model = createFixtureModel(input.modelOptions);
  requireExplicitModel(model);

  return {
    model,
    name: input.name,
    runtimeConfig: {
      mode: "yolo",
      modelStreaming: "on",
    },
    steps: [
      {
        text: input.prompt,
        type: "submitPrompt",
      },
    ],
  };
}

function requireExplicitModel(
  model: PromptTrajectoryFixture["model"] | undefined,
): asserts model is NonNullable<PromptTrajectoryFixture["model"]> {
  const hasIdentity = Boolean(model?.id || (model?.provider && model.model));
  if (!hasIdentity || !model?.upstreamBaseURL) {
    throw new Error(
      "Explicit model options are required: provide provider/model and upstreamBaseURL.",
    );
  }
}

function createFixtureModel(
  modelOptions: SharedModelOptions | undefined,
): PromptTrajectoryFixture["model"] | undefined {
  if (!modelOptions) return undefined;
  const model: PromptTrajectoryFixture["model"] = {};
  if (modelOptions.modelId !== undefined) {
    model.id = modelOptions.modelId;
  }
  if (modelOptions.upstreamBaseURL !== undefined) {
    model.upstreamBaseURL = modelOptions.upstreamBaseURL;
  }
  if (modelOptions.apiKey !== undefined) {
    model.apiKey = modelOptions.apiKey;
  }
  if (modelOptions.apiKeyEnv !== undefined) {
    model.apiKeyEnv = modelOptions.apiKeyEnv;
  }
  if (Object.keys(model).length === 0) return undefined;
  model.kind = "openai-compatible";
  return model;
}

function formatTimestamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
}
