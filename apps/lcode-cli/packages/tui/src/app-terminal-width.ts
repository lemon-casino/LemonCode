const TRUNCATION_SUFFIX = "...";
const INTER_WORD_SPACE_WIDTH = 1;
const LINE_BREAK_PATTERN = /\r?\n/u;
const WHITESPACE_PATTERN = /\s+/u;

export function truncateDisplay(value: string, maxCells: number): string {
  if (displayWidth(value) <= maxCells) return value;
  if (maxCells <= TRUNCATION_SUFFIX.length) return value.slice(0, Math.max(0, maxCells));

  let cells = 0;
  let output = "";
  for (const char of value) {
    const width = terminalCharWidth(char);
    if (cells + width > maxCells - TRUNCATION_SUFFIX.length) break;
    output += char;
    cells += width;
  }
  return `${output}${TRUNCATION_SUFFIX}`;
}

export function wordWrappedLineCount(value: string, maxCells: number): number {
  const widthLimit = Math.max(1, Math.floor(maxCells));
  let lineCount = 0;

  for (const paragraph of value.split(LINE_BREAK_PATTERN)) {
    const words = paragraph.trim().split(WHITESPACE_PATTERN).filter(Boolean);
    if (words.length === 0) {
      lineCount += 1;
      continue;
    }

    let currentLineWidth = 0;
    for (const word of words) {
      const wordWidth = displayWidth(word);
      if (currentLineWidth === 0) {
        const wrapped = wrappedTokenLineCount(wordWidth, widthLimit);
        lineCount += wrapped - 1;
        currentLineWidth = wrappedTokenRemainderWidth(wordWidth, widthLimit);
        continue;
      }

      const nextLineWidth = currentLineWidth + INTER_WORD_SPACE_WIDTH + wordWidth;
      if (nextLineWidth <= widthLimit) {
        currentLineWidth = nextLineWidth;
        continue;
      }

      lineCount += 1;
      const wrapped = wrappedTokenLineCount(wordWidth, widthLimit);
      lineCount += wrapped - 1;
      currentLineWidth = wrappedTokenRemainderWidth(wordWidth, widthLimit);
    }
    lineCount += 1;
  }

  return lineCount;
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) width += terminalCharWidth(char);
  return width;
}

function terminalCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0;
  if (
    code >= 0x1100 &&
    (code <= 0x115f ||
      code === 0x2329 ||
      code === 0x232a ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe10 && code <= 0xfe19) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6))
  ) {
    return 2;
  }
  return 1;
}

function wrappedTokenLineCount(width: number, widthLimit: number): number {
  return Math.max(1, Math.ceil(width / widthLimit));
}

function wrappedTokenRemainderWidth(width: number, widthLimit: number): number {
  if (width <= 0) return 0;
  const remainder = width % widthLimit;
  return remainder === 0 ? widthLimit : remainder;
}
