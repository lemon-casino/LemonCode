import type { AuthModel } from "../driver.js";
import { record, text, type Fetcher } from "./common.js";
import { PublicCatalog, catalogMetadata } from "./catalog-metadata.js";
const aliases: AuthModel[] = ["sonnet", "opus", "haiku"].map((id) => ({
  id,
  name: `Claude ${id[0]!.toUpperCase()}${id.slice(1)} (CLI)`,
  protocol: "anthropic-messages",
  baseURL: "https://api.anthropic.com/v1",
  images: true,
  toolCall: true,
}));
/** Public catalog, never an Anthropic request carrying the user's subscription token. */
export class ClaudeModels {
  private readonly catalog: PublicCatalog;
  constructor(request: Fetcher = fetch) {
    this.catalog = new PublicCatalog(request);
  }
  async read(signal?: AbortSignal): Promise<{ models: readonly AuthModel[]; fallback: boolean }> {
    const { data, fallback } = await this.catalog.read(signal);
    const models: AuthModel[] = Object.entries(record(record(data.anthropic).models)).flatMap(
      ([id, value]) => {
        const model = record(value);
        if (!id.startsWith("claude-") || model.status === "deprecated") return [];
        return [
          {
            id,
            name: text(model.name) || id,
            protocol: "anthropic-messages",
            baseURL: "https://api.anthropic.com/v1",
            ...catalogMetadata(model),
          },
        ];
      },
    );
    return { models: [...aliases, ...models], fallback: fallback || !models.length };
  }
}
