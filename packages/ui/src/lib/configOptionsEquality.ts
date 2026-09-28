import type { LCodeConfigOption } from "@lcode/shared";

function areJsonEquivalent(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function areConfigOptionsEquivalent(
  left: readonly LCodeConfigOption[] | null | undefined,
  right: readonly LCodeConfigOption[] | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right || left.length !== right.length) {
    return false;
  }

  return left.every((option, index) => {
    const rightOption = right[index];
    return Boolean(rightOption) && areJsonEquivalent(option, rightOption);
  });
}
