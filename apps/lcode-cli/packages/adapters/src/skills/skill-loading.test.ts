import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SkillDiagnostic, SkillRoot } from "@lcode/contracts";
import { createNodeSkillAdapter, NodeSkillAdapter } from "./index.js";
import { extractFrontmatter, parseFlatYaml, parseScalar, stripFrontmatter } from "./frontmatter.js";

test("frontmatter parsing preserves BOM, quoted scalars, block styles and diagnostics", () => {
  const content =
    "\uFEFF---\nname: 'sample'\ndescription: >\n  first line\n  second line\n\n  paragraph\nwhen_to_use: |\n  one\n  two\nmalformed\n---\nbody";
  const diagnostics: SkillDiagnostic[] = [];
  const frontmatter = extractFrontmatter(content);
  assert.ok(frontmatter);
  const parsed = parseFlatYaml(frontmatter, "SKILL.md", diagnostics);
  assert.equal(parseScalar(parsed.values.name), "sample");
  assert.equal(parsed.values.description, "first line second line\nparagraph");
  assert.equal(parsed.values.when_to_use, "one\ntwo");
  assert.deepEqual(parsed.keys, ["name", "description", "when_to_use"]);
  assert.equal(diagnostics[0]?.code, "skill_invalid_frontmatter");
  assert.equal(stripFrontmatter(content), "body");
  assert.equal(extractFrontmatter("ordinary body"), null);
  assert.equal(stripFrontmatter("ordinary body"), "ordinary body");
});

test("skill adapter retains path identity, disabled paths, aliases and one manifest cache", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "lcode-skills-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const pluginDirectory = join(directory, "plugin");
  const rootPath = join(pluginDirectory, "skills");
  const skillDirectory = join(rootPath, "sample");
  const disabledDirectory = join(rootPath, "disabled");
  await mkdir(join(pluginDirectory, ".lcode-plugin"), { recursive: true });
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(disabledDirectory, { recursive: true });
  const manifestPath = join(pluginDirectory, ".lcode-plugin", "plugin.json");
  await writeFile(manifestPath, JSON.stringify({ name: "fixture-plugin" }));
  await writeFile(
    join(skillDirectory, "SKILL.md"),
    "---\nname: sample\ndescription: description\nversion: 1\n---\nbody",
  );
  const disabledPath = join(disabledDirectory, "SKILL.md");
  await writeFile(disabledPath, "plain skill body");
  const root: SkillRoot = {
    path: rootPath,
    scope: "project",
    source: "plugin",
    priority: 1,
    pluginId: "fixture-plugin@fixture-market",
  };
  const adapter = createNodeSkillAdapter({ disabledPaths: [disabledPath] });
  const request = { workingDirectory: directory, roots: [root] };
  const outcome = await adapter.discoverSkills(request);
  assert.equal(outcome.skills.length, 1);
  assert.equal(outcome.skills[0]?.qualifiedName, "fixture-plugin:sample");
  assert.equal(outcome.skills[0]?.safeToAutoLoad, false);
  assert.equal(outcome.totalDiscovered, 1);
  await writeFile(manifestPath, JSON.stringify({ name: "changed-plugin" }));
  const loaded = await adapter.loadSkill({ ...request, name: "fixture-plugin:sample" });
  assert.equal(loaded.content, "body");
  assert.equal(loaded.metadata.pluginName, "fixture-plugin");
  assert.equal(loaded.baseDirectory, skillDirectory);
  await assert.rejects(adapter.loadSkill({ ...request, name: "disabled" }), /Skill not found/);
  await assert.rejects(
    adapter.discoverSkills(request, { signal: AbortSignal.abort() }),
    /cancelled/,
  );
  assert.equal(NodeSkillAdapter.length, 0);
  assert.equal(createNodeSkillAdapter.length, 0);
  assert.equal(NodeSkillAdapter.prototype.discoverSkills.length, 2);
  assert.equal(NodeSkillAdapter.prototype.loadSkill.length, 2);
});
