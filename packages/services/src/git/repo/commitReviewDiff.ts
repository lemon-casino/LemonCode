import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitCommitReviewGroup } from "@lcode/shared";
import type { CommitReviewContent } from "../commitReviewPlanner.js";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";

export async function describeCommitReviewFiles(
  command: GitCommandProvider,
  files: readonly CommitReviewContent[],
): Promise<GitCommitReviewGroup["files"]> {
  const temp = await mkdtemp(join(tmpdir(), "lcode-review-diff-"));
  try {
    const result: GitCommitReviewGroup["files"] = [];
    for (const file of files) {
      const before = join(temp, "before"),
        after = join(temp, "after");
      await Promise.all([
        writeFile(before, file.headContent ?? ""),
        writeFile(after, file.content ?? ""),
      ]);
      const diff = await command.run({
        cwd: temp,
        args: ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", before, after],
        maxOutputBytes: 2_097_152,
      });
      if ((diff.exitCode !== 0 && diff.exitCode !== 1) || diff.outputTruncated || diff.timedOut)
        throw new Error("无法完整读取审核补丁。");
      const lines = diff.stdout.split("\n");
      let patch = lines
        .map((line) =>
          line.startsWith("diff --git ")
            ? `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}`
            : line.startsWith("--- ")
              ? `--- ${file.headContent === null ? "/dev/null" : JSON.stringify(`a/${file.path}`)}`
              : line.startsWith("+++ ")
                ? `+++ ${file.content === null ? "/dev/null" : JSON.stringify(`b/${file.path}`)}`
                : line,
        )
        .join("\n");
      const metadata =
        file.headContent === null
          ? `new file mode ${file.mode}`
          : file.content === null
            ? `deleted file mode ${file.headMode ?? file.mode}`
            : file.headMode && file.headMode !== file.mode
              ? `old mode ${file.headMode}\nnew mode ${file.mode}`
              : "";
      if (metadata) {
        const firstLine = patch.indexOf("\n") + 1;
        patch = patch
          ? `${patch.slice(0, firstLine)}${metadata}\n${patch.slice(firstLine)}`
          : `diff --git ${JSON.stringify(`a/${file.path}`)} ${JSON.stringify(`b/${file.path}`)}\n${metadata}\n`;
      }
      result.push({
        path: file.path,
        patch,
        added: lines.filter((line) => line.startsWith("+") && !line.startsWith("+++ ")).length,
        removed: lines.filter((line) => line.startsWith("-") && !line.startsWith("--- ")).length,
      });
    }
    return result;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
