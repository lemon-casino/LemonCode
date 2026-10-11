import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

const WINDOWS_REPLACE_ERRORS = new Set(["UNKNOWN", "EBUSY", "EPERM", "EACCES"]);
const REPLACE_DELAYS_MS = [25, 50, 100, 200];

export async function writeNoticeArtifacts(
  { root, notices, inventory },
  { io = fs, platform = process.platform, wait = setTimeout } = {},
) {
  const noticePath = resolve(root, "THIRD-PARTY-NOTICES.md");
  const inventoryPath = resolve(root, "third-party/inventory.json");
  const id = randomUUID();
  const noticeTemp = `${noticePath}.${id}.tmp`;
  const inventoryTemp = `${inventoryPath}.${id}.tmp`;
  const backup = `${noticePath}.${id}.backup`;
  let noticeCommitted = false;
  let oldNotice;
  let keepBackup = false;

  async function replace(source, destination) {
    for (let attempt = 0; ; attempt++) {
      try {
        await io.rename(source, destination);
        return;
      } catch (error) {
        if (
          platform !== "win32" ||
          !WINDOWS_REPLACE_ERRORS.has(error.code) ||
          attempt === REPLACE_DELAYS_MS.length
        )
          throw error;
        await wait(REPLACE_DELAYS_MS[attempt]);
      }
    }
  }

  try {
    try {
      oldNotice = await io.readFile(noticePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // 修复依据：Windows 日志确认 inventory 截断写出现 UNKNOWN（文件映射/占用可引起此类错误）；先写新文件再替换。
    // 两份临时产物均就绪才提交，inventory 失败时使用提前保存的 NOTICE 恢复原摘要关系。
    await io.writeFile(noticeTemp, notices, { flag: "wx" });
    await io.writeFile(inventoryTemp, `${JSON.stringify(inventory, null, 2)}\n`, { flag: "wx" });
    if (oldNotice !== undefined) await io.writeFile(backup, oldNotice, { flag: "wx" });
    await replace(noticeTemp, noticePath);
    noticeCommitted = true;
    await replace(inventoryTemp, inventoryPath);
  } catch (error) {
    if (noticeCommitted) {
      try {
        if (oldNotice !== undefined) await replace(backup, noticePath);
        else await io.rm(noticePath, { force: true });
      } catch (restoreError) {
        keepBackup = oldNotice !== undefined;
        throw new AggregateError(
          [error, restoreError],
          `NOTICE commit and rollback failed; previous notice retained at ${backup}`,
        );
      }
    }
    throw error;
  } finally {
    await Promise.all(
      [noticeTemp, inventoryTemp, ...(keepBackup ? [] : [backup])].map((path) =>
        io.rm(path, { force: true }),
      ),
    );
  }
}
