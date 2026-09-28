const packageDirName = "lcode";

export function installScriptSource(baseUrl) {
  return `#!/usr/bin/env sh
set -eu

BASE_URL="\${LCODE_DIST_BASE_URL:-${baseUrl}}"
INSTALL_DIR="\${LCODE_DIST_HOME:-$HOME/.lcode/runtime}"
BIN_DIR="\${LCODE_DIST_BIN_DIR:-$HOME/.local/bin}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "lcode install requires $1" >&2
    exit 1
  fi
}

need_cmd node
need_cmd curl
need_cmd tar

LATEST_JSON="$(curl -fsSL "\${BASE_URL%/}/latest.json")"
VERSION="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).version))")"
TARBALL="$(printf '%s' "$LATEST_JSON" | node -e "let data='';process.stdin.on('data',c=>data+=c);process.stdin.on('end',()=>process.stdout.write(JSON.parse(data).tarball))")"

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

ARCHIVE="$TMP_DIR/$TARBALL"
curl -fL "\${BASE_URL%/}/releases/$VERSION/$TARBALL" -o "$ARCHIVE"

mkdir -p "$INSTALL_DIR/releases" "$BIN_DIR"
TARGET="$INSTALL_DIR/releases/$VERSION"
rm -rf "$TARGET.new"
mkdir -p "$TARGET.new"
tar -xzf "$ARCHIVE" -C "$TARGET.new"
rm -rf "$TARGET"
mv "$TARGET.new/${packageDirName}" "$TARGET"
rm -rf "$TARGET.new"
ln -sfn "$TARGET" "$INSTALL_DIR/current"

cat > "$BIN_DIR/lcode" <<SH
#!/usr/bin/env sh
exec node "$INSTALL_DIR/current/bin/lcode.mjs" "\\$@"
SH
chmod +x "$BIN_DIR/lcode"

echo "LCode $VERSION installed."
echo "Run: lcode (TUI) or lcode --web (Web)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH." ;;
esac
`;
}
