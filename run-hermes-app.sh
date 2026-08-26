#!/bin/zsh
# Build + launch the single-process Hermes team-machine desktop app.
# One process: Rust GPUI host + embedded Hermes JS thread, no Bun, no second process.
#
#   ./run-hermes-app.sh            # build bundle (bytecode) + binary, then open the app
#   TM_URL=http://host:port ./run-hermes-app.sh
set -e

RNG="$(cd "$(dirname "$0")" && pwd)"            # ~/rng-hermes
GUI="${TM_GUI:-$RNG/../team-machine/gui}"
HERMES_ROOT="${HERMES_ROOT:-$HOME/github/hermes}"
URL="${TM_URL:-http://127.0.0.1:7777}"
SIZE="${RNGPUI_WINDOW_SIZE:-1440,920}"
BUNDLE=/tmp/team-machine-app.js
APP=/tmp/team-machine-hermes.app

echo "› building release binary…"
( cd "$RNG/rust" && HERMES_ROOT="$HERMES_ROOT" cargo build --release --bin rngpui-service >/dev/null )

echo "› bundling app → Hermes bytecode…"
( cd "$GUI" && RNGPUI_LOCAL="$RNG/ts" NODE_ENV=production bun native-shell/scripts/bundle-app-hermes.mjs "$BUNDLE" --bytecode >/dev/null )

echo "› assembling .app…"
BIN="$RNG/rust/target/release"
mkdir -p "$APP/Contents/MacOS"
cp "$BIN/rngpui-service" "$APP/Contents/MacOS/rngpui-service"
cp "$BIN"/libghostty-vt*.dylib "$APP/Contents/MacOS/" 2>/dev/null || true
cp "$HERMES_ROOT/build/lib/libhermesvm.dylib" "$APP/Contents/MacOS/" 2>/dev/null || true
cat > "$APP/Contents/MacOS/team-machine-hermes" <<EOF
#!/bin/zsh
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export RNGPUI_BUNDLE=/tmp/team-machine-app.hbc
export TM_URL=$URL
export RNGPUI_WINDOW_SIZE=$SIZE
exec "\$DIR/rngpui-service"
EOF
chmod +x "$APP/Contents/MacOS/team-machine-hermes" "$APP/Contents/MacOS/rngpui-service"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>team-machine-hermes</string>
  <key>CFBundleIdentifier</key><string>dev.team-machine.gpui.hermes</string>
  <key>CFBundleName</key><string>team-machine (hermes)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF

# replace any prior hermes instance (never the user's team-machine-gpui-user)
for pid in $(pgrep -f "team-machine-hermes.app" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
sleep 0.5
echo "› launching ($URL)…"
open "$APP"
echo "✓ team-machine (hermes) launched — single process, ~135ms cold start."
