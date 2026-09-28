import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LCodeStdioTapDevState } from "@lcode/shared";
import { getAppConfigDir } from "#src/paths.js";
import { isEffectiveDevelopmentNodeEnv } from "#src/runtime-tools/nodeEnv.js";

interface LCodeStdioTapStateFile {
  enabled?: boolean;
}

function isLCodeStdioTapDevVisible(): boolean {
  return isEffectiveDevelopmentNodeEnv();
}

function getLCodeStdioTapDevDir(): string {
  return join(getAppConfigDir(), "dev");
}

export function getLCodeStdioTapDevLogDir(): string {
  return join(getLCodeStdioTapDevDir(), "stdio-traffic");
}

function getLCodeStdioTapDevStatePath(): string {
  return join(getLCodeStdioTapDevDir(), "lcode-stdio-tap.json");
}

function readStateFile(path: string): LCodeStdioTapStateFile {
  if (!existsSync(path)) {
    return {};
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as LCodeStdioTapStateFile) : {};
  } catch {
    return {};
  }
}

export function readLCodeStdioTapDevState(): LCodeStdioTapDevState {
  const visible = isLCodeStdioTapDevVisible();
  const statePath = getLCodeStdioTapDevStatePath();
  const fileState = readStateFile(statePath);
  return {
    enabled: visible && fileState.enabled === true,
    visible,
    logDir: getLCodeStdioTapDevLogDir(),
    statePath,
  };
}

export function setLCodeStdioTapDevEnabled(enabled: boolean): LCodeStdioTapDevState {
  const visible = isLCodeStdioTapDevVisible();
  const statePath = getLCodeStdioTapDevStatePath();
  mkdirSync(getLCodeStdioTapDevDir(), { recursive: true });
  writeFileSync(
    statePath,
    `${JSON.stringify(
      {
        // 开发态 stdio 抓包是高频原始协议帧，只能通过显式开关写旁路文件，避免误进生产日志。
        enabled: visible && enabled,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return readLCodeStdioTapDevState();
}
