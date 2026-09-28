import { createReadStream, createWriteStream } from "node:fs";
import { chmod } from "node:fs/promises";
import { join } from "node:path";

const executableModeMask = 0o777;
const progressCompletePercent = 100;
const uploadProgressIntervalMs = 200;

export const fileMode = (stats) => stats.mode & executableModeMask;

export const formatBytes = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(1)} ${unit}`;
    value /= 1024;
  }

  return `${value.toFixed(1)} TB`;
};

export const createConsoleProgressReporter = ({ stdout = process.stdout } = {}) => {
  let lastProgressAt = 0;
  let lastLineLength = 0;
  let lastNonTtyPercent = -1;

  const writeProgressLine = (line) => {
    if (!stdout.isTTY) {
      stdout.write(`${line}\n`);
      return;
    }

    const padded = line.padEnd(lastLineLength, " ");
    stdout.write(`\r${padded}`);
    lastLineLength = line.length;
  };

  const finishTtyLine = () => {
    if (stdout.isTTY && lastLineLength > 0) {
      stdout.write("\n");
      lastLineLength = 0;
    }
  };

  return (event) => {
    if (event.type === "file-start") {
      writeProgressLine(`[upload] ${event.index}/${event.totalFiles} ${event.fileName} starting`);
      return;
    }

    if (event.type === "progress") {
      const now = Date.now();
      const percent =
        event.totalBytes === 0
          ? progressCompletePercent
          : Math.floor((event.totalCopiedBytes / event.totalBytes) * progressCompletePercent);
      if (!stdout.isTTY && percent < lastNonTtyPercent + 10 && percent < progressCompletePercent) {
        return;
      }

      if (stdout.isTTY && now - lastProgressAt < uploadProgressIntervalMs) return;
      lastProgressAt = now;
      lastNonTtyPercent = percent;
      writeProgressLine(
        `[upload] ${event.index}/${event.totalFiles} ${event.fileName} ` +
          `${formatBytes(event.fileCopiedBytes)}/${formatBytes(event.fileSize)} ` +
          `total ${formatBytes(event.totalCopiedBytes)}/${formatBytes(event.totalBytes)} ` +
          `${percent}%`,
      );
      return;
    }

    if (event.type === "file-complete") {
      writeProgressLine(`[upload] ${event.index}/${event.totalFiles} ${event.fileName} complete`);
      return;
    }

    if (event.type === "complete") {
      finishTtyLine();
      stdout.write(
        `[upload] complete: ${event.totalFiles} files, ${formatBytes(event.totalCopiedBytes)}\n`,
      );
    }
  };
};

const copyFileWithProgress = async ({
  aggregate,
  destination,
  file,
  index,
  onProgress,
  totalFiles,
}) =>
  new Promise((resolveCopy, rejectCopy) => {
    let fileCopiedBytes = 0;
    const readStream = createReadStream(file.source);
    const writeStream = createWriteStream(destination, {
      mode: file.mode,
    });

    const rejectOnce = (error) => {
      readStream.destroy();
      writeStream.destroy();
      rejectCopy(error);
    };

    readStream.on("data", (chunk) => {
      fileCopiedBytes += chunk.length;
      aggregate.copiedBytes += chunk.length;
      onProgress({
        fileCopiedBytes,
        fileName: file.fileName,
        fileSize: file.size,
        index,
        totalBytes: aggregate.totalBytes,
        totalCopiedBytes: aggregate.copiedBytes,
        totalFiles,
        type: "progress",
      });
    });
    readStream.on("error", rejectOnce);
    writeStream.on("error", rejectOnce);
    writeStream.on("finish", () => {
      chmod(destination, file.mode)
        .catch(() => undefined)
        .then(resolveCopy, rejectCopy);
    });

    readStream.pipe(writeStream);
  });

export const copyReleaseFiles = async ({ files, onProgress, stagingDirectory }) => {
  const aggregate = {
    copiedBytes: 0,
    totalBytes: files.reduce((sum, file) => sum + file.size, 0),
  };

  onProgress({
    totalBytes: aggregate.totalBytes,
    totalFiles: files.length,
    type: "start",
  });

  for (const [index, file] of files.entries()) {
    const fileIndex = index + 1;
    onProgress({
      fileName: file.fileName,
      fileSize: file.size,
      index: fileIndex,
      totalBytes: aggregate.totalBytes,
      totalFiles: files.length,
      type: "file-start",
    });
    await copyFileWithProgress({
      aggregate,
      destination: join(stagingDirectory, file.fileName),
      file,
      index: fileIndex,
      onProgress,
      totalFiles: files.length,
    });
    onProgress({
      fileName: file.fileName,
      fileSize: file.size,
      index: fileIndex,
      totalBytes: aggregate.totalBytes,
      totalCopiedBytes: aggregate.copiedBytes,
      totalFiles: files.length,
      type: "file-complete",
    });
  }

  onProgress({
    totalBytes: aggregate.totalBytes,
    totalCopiedBytes: aggregate.copiedBytes,
    totalFiles: files.length,
    type: "complete",
  });

  return aggregate;
};
