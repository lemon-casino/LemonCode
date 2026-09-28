export function windowsPathToGitBashPath(value: string): string {
  if (value.startsWith("\\\\")) return value.replaceAll("\\", "/");
  const driveMatch = value.match(/^([A-Za-z]):(?:[/\\]|$)/u);
  if (driveMatch) {
    const rest = value.slice(2).replaceAll("\\", "/");
    return `/${driveMatch[1]!.toLowerCase()}${rest.startsWith("/") ? rest : `/${rest}`}`;
  }
  return value.replaceAll("\\", "/");
}

export function gitBashPathToWindowsPath(value: string): string {
  if (value.startsWith("//")) return value.replaceAll("/", "\\");
  const cygdrive = value.match(/^\/cygdrive\/([A-Za-z])(\/|$)/u);
  if (cygdrive) {
    const rest = value.slice(`/cygdrive/${cygdrive[1]}`.length);
    return `${cygdrive[1]!.toUpperCase()}:${gitBashRestToWindowsPathRest(rest)}`;
  }
  const drive = value.match(/^\/([A-Za-z])(\/|$)/u);
  if (drive) {
    const rest = value.slice(2);
    return `${drive[1]!.toUpperCase()}:${gitBashRestToWindowsPathRest(rest)}`;
  }
  return value.replaceAll("/", "\\");
}

function gitBashRestToWindowsPathRest(rest: string): string {
  const converted = rest.replaceAll("/", "\\").replace(/^\\+/u, "");
  return converted.length > 0 ? `\\${converted}` : "\\";
}
