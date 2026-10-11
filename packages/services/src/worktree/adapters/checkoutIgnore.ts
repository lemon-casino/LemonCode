import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";

/** 项目内 checkout 必须在创建前从原仓库 Git 扫描中排除，避免快照递归收集其它树。 */
export async function ignoreNestedCheckoutRoot(
  repositoryRoot: string,
  commonDirectory: string,
  checkoutRoot: string,
) {
  const child = relative(repositoryRoot, checkoutRoot);
  if (!child || isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) return;
  const pattern = `/${child
    .split(sep)
    .join("/")
    .replace(/[\\*?[\]#! ]/g, "\\$&")}/`;
  const path = join(commonDirectory, "info", "exclude");
  await withFileLock(path, async () => {
    let previous = "";
    try {
      previous = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (previous.split(/\r?\n/).includes(pattern)) return;
    await atomicWritePrivateTextFile(
      path,
      `${previous}${previous.endsWith("\n") || !previous ? "" : "\n"}${pattern}\n`,
    );
  });
}
