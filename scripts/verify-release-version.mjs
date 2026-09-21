import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(import.meta.dirname, "..");

export function verifyReleaseVersion({ version, refType, refName }) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Unsupported desktop release version: ${version}`);
  }
  if (refType === "tag" && refName !== `v${version}`) {
    throw new Error(`Release tag ${refName} does not match package.json version ${version}`);
  }
  return version;
}

async function main() {
  const pkg = JSON.parse(await readFile(resolve(repoRoot, "package.json"), "utf8"));
  const version = verifyReleaseVersion({
    version: pkg.version,
    refType: process.env.GITHUB_REF_TYPE,
    refName: process.env.GITHUB_REF_NAME,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\n`, "utf8");
  }
  console.log(`Desktop release version: ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
