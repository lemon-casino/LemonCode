import { createProjectId } from "../deps.js";
import type { ProjectId } from "../deps.js";

export function titleFromInput(input: string): string {
  const compact = input.trim().replace(/\s+/g, " ");
  if (!compact) return "Untitled session";
  return compact.length <= 60 ? compact : `${compact.slice(0, 57)}...`;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "session";
}

export function projectIdFromDirectory(directory: string): ProjectId {
  return createProjectId(slugify(directory).slice(0, 80) || "default");
}
