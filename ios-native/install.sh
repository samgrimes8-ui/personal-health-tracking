#!/usr/bin/env bash
# install.sh — build + install + launch MacroLens on the connected iPhone.
#
# Run from anywhere:  ./ios-native/install.sh
#
# Discovers the iPhone at runtime (no hardcoded device IDs), so the same
# script works on any Mac with any paired phone. Uses the standard Apple
# toolchain — xcodebuild for the build, xcrun devicectl for install +
# launch — so anything that breaks at the CLI level should reproduce in
# Xcode itself.

set -euo pipefail
cd "$(dirname "$0")"

bundle_id="app.macrolens.native"
project="MacroLens.xcodeproj"
scheme="MacroLens"

# ── 1. Find the connected iPhone ─────────────────────────────────────────
# devicectl gives a UUID-style id; xcodebuild speaks a different id
# format (e.g. 00008101-...). We need both, so look up each separately.
echo "→ Looking for a connected iPhone..."
devicectl_id=$(xcrun devicectl list devices 2>/dev/null \
  | grep "connected" \
  | grep -i "iPhone" \
  | grep -oE "[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}" \
  | head -1)
if [[ -z "$devicectl_id" ]]; then
  echo "  No connected iPhone found." >&2
  echo "  Plug in via USB, or pair for Wi-Fi:" >&2
  echo "    Xcode → Window → Devices and Simulators → Connect via network" >&2
  exit 1
fi
echo "  devicectl id: $devicectl_id"

echo "→ Resolving xcodebuild destination id..."
xcode_id=$(xcodebuild -project "$project" -scheme "$scheme" -showdestinations 2>/dev/null \
  | awk '/platform:iOS, arch:/ && !/Simulator|placeholder/ { sub(/.*id:/, ""); sub(/,.*$/, ""); print; exit }')
if [[ -z "$xcode_id" ]]; then
  echo "  Couldn't resolve a real iPhone destination from xcodebuild." >&2
  echo "  Open MacroLens.xcodeproj in Xcode once so it indexes the device, then re-run." >&2
  exit 1
fi
echo "  xcodebuild id: $xcode_id"

# ── 2. Build ──────────────────────────────────────────────────────────────
# -quiet hides the verbose compile spam. If something breaks, re-run
# without it to see the full log.
echo "→ Building..."
xcodebuild -project "$project" -scheme "$scheme" \
  -destination "platform=iOS,id=$xcode_id" \
  -allowProvisioningUpdates -quiet build

# ── 3. Find the .app bundle ──────────────────────────────────────────────
# Ask xcodebuild where it dropped the binary rather than guessing inside
# DerivedData — that path includes a per-project hash that changes if the
# user renames the directory.
echo "→ Locating built .app..."
build_dir=$(xcodebuild -project "$project" -scheme "$scheme" \
  -destination "platform=iOS,id=$xcode_id" \
  -showBuildSettings 2>/dev/null \
  | awk -F' = ' '/^[[:space:]]*BUILT_PRODUCTS_DIR[[:space:]]*=/ { print $2; exit }')
app_path="$build_dir/MacroLens.app"
if [[ ! -d "$app_path" ]]; then
  echo "  Build succeeded but $app_path doesn't exist — DerivedData may be in a non-default location." >&2
  exit 1
fi
echo "  $app_path"

# ── 4. Install + launch ──────────────────────────────────────────────────
echo "→ Installing..."
xcrun devicectl device install app --device "$devicectl_id" "$app_path" > /dev/null

echo "→ Launching..."
xcrun devicectl device process launch \
  --device "$devicectl_id" \
  --terminate-existing "$bundle_id" > /dev/null

echo
echo "✓ MacroLens is running on your phone."
