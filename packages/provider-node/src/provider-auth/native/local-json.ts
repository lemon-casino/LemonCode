/** CLI config accepts JSON comments and trailing commas; strings, including URLs, stay intact. */
export function parseLocalJSON(source: string): unknown {
  let clean = "",
    quoted = false,
    escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      clean += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      clean += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++;
      clean += "\n";
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i++;
      clean += " ";
      continue;
    }
    clean += char;
  }
  let out = "";
  quoted = false;
  escaped = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i]!;
    if (quoted) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    if (char === "," && /^[\s]*[}\]]/u.test(clean.slice(i + 1))) continue;
    out += char;
  }
  return JSON.parse(out.replace(/^\uFEFF/u, ""));
}
