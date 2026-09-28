export type SafeFlagValue = "{}" | "EOF" | "char" | "none" | "number" | "optionalString" | "string";

export interface BashReadonlyCommandPolicy {
  additionalCommandIsDangerousCallback?: (
    commandText: string,
    argsAfterPrefix: readonly string[],
  ) => boolean;
  allowAnyArgs?: boolean;
  allowCompactNumericCountFlag?: boolean;
  commandOnly?: boolean;
  regex?: RegExp;
  respectsDoubleDash?: boolean;
  safeFlags?: Readonly<Record<string, SafeFlagValue>>;
}
