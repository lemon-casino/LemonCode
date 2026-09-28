const HAN_RUN_PATTERN = /\p{Script=Han}+/gu;
const IDENTIFIER_PATTERN = /[\p{Script=Latin}\p{N}_-]+/gu;
const CAMEL_LOWER_TO_UPPER_PATTERN = /([\p{Ll}\p{N}])(\p{Lu})/gu;
const CAMEL_ACRONYM_PATTERN = /(\p{Lu}+)(\p{Lu}\p{Ll})/gu;

export function tokenizeMemoryRecallText(text: string): string[] {
  const normalized = text.normalize("NFKC");
  const tokens: string[] = [];

  for (const match of normalized.matchAll(HAN_RUN_PATTERN)) {
    const characters = Array.from(match[0]);
    if (characters.length === 1) {
      tokens.push(characters[0]!);
      continue;
    }
    for (let index = 0; index < characters.length - 1; index++) {
      tokens.push(`${characters[index]}${characters[index + 1]}`);
    }
  }

  for (const match of normalized.matchAll(IDENTIFIER_PATTERN)) {
    const identifier = match[0];
    const folded = identifier.toLowerCase();
    tokens.push(folded);

    const parts = identifier
      .replace(CAMEL_ACRONYM_PATTERN, "$1 $2")
      .replace(CAMEL_LOWER_TO_UPPER_PATTERN, "$1 $2")
      .split(/[_\-\s]+/u)
      .map((part) => part.toLowerCase())
      .filter(Boolean);
    if (parts.length > 1 || parts[0] !== folded) tokens.push(...parts);
  }

  return tokens;
}
