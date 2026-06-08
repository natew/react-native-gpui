#!/bin/zsh
# Build + launch the single-process Hermes agentbus desktop app.
# One process: Rust GPUI host + embedded Hermes JS thread, no Bun, no second process.
#
#   ./run-hermes-app.sh            # build bundle (bytecode) + binary, then open the app
#   AGENTBUS_URL=http://host:port ./run-hermes-app.sh
set -e

RNG="$(cd "$(dirname "$0")" && pwd)"            # ~/rng-hermes
GUI="${AGENTBUS_GUI:-$RNG/../agentbus/gui}"
HERMES_ROOT="${HERMES_ROOT:-$HOME/github/hermes}"
URL="${AGENTBUS_URL:-http://127.0.0.1:7777}"
SIZE="${RNGPUI_WINDOW_SIZE:-1440,920}"
BUNDLE=/tmp/agentbus-app.js
APP=/tmp/agentbus-hermes.app

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
cat > "$APP/Contents/MacOS/agentbus-hermes" <<EOF
#!/bin/zsh
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
export RNGPUI_BUNDLE=/tmp/agentbus-app.hbc
export AGENTBUS_URL=$URL
export RNGPUI_WINDOW_SIZE=$SIZE
exec "\$DIR/rngpui-service"
EOF
chmod +x "$APP/Contents/MacOS/agentbus-hermes" "$APP/Contents/MacOS/rngpui-service"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>agentbus-hermes</string>
  <key>CFBundleIdentifier</key><string>dev.agentbus.gpui.hermes</string>
  <key>CFBundleName</key><string>agentbus (hermes)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF

# replace any prior hermes instance (never the user's agentbus-gpui-user)
for pid in $(pgrep -f "agentbus-hermes.app" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
sleep 0.5
echo "› launching ($URL)…"
open "$APP"
echo "✓ agentbus (hermes) launched — single process, ~135ms cold start."
