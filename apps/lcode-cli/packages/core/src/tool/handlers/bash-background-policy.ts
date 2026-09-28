import type { BashInput } from "@lcode/contracts";

export function isBashAutoBackgroundEligible(input: BashInput): boolean {
  if (input.run_in_background === true) return false;
  const command = input.command.trim();
  if (command.length === 0) return false;
  const firstToken = command.split(/\s+/u)[0];
  return firstToken !== "sleep";
}
