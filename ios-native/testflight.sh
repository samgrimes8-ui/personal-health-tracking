#!/usr/bin/env bash
# testflight.sh — archive + upload to TestFlight.
#
# Builds an App Store-ready IPA, uploads it via App Store Connect API,
# Apple processes for ~5–30 min, build appears in TestFlight on every
# tester's phone. From there to your phone:
#   1. Run this script
#   2. Wait for the email "MacroLens X is ready to test"
#   3. Open TestFlight on your phone, MacroLens, Update.
#
# One-time setup before this works — see TESTFLIGHT.md. tl;dr:
#   - Apple Developer Program enrollment ($99/yr)
#   - App record at App Store Connect with bundle id app.macrolens.native
#   - App Store Connect API key (.p8 file) at
#       ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#   - Credentials in ios-native/.testflight.env (gitignored):
#       APP_STORE_CONNECT_KEY_ID=ABC123
#       APP_STORE_CONNECT_ISSUER_ID=xxx-xxx-xxx-xxx-xxx
#
# Auto-bumps the build number to the current commit count, so every
# upload monotonically increases without manual editing.

set -euo pipefail
cd "$(dirname "$0")"

project="MacroLens.xcodeproj"
scheme="MacroLens"
archive_path="build/MacroLens.xcarchive"
export_path="build/export"
ipa_path="$export_path/MacroLens.ipa"

# ── 1. Load credentials ─────────────────────────────────────────────────
if [[ -f .testflight.env ]]; then
  set -o allexport
  # shellcheck disable=SC1091
  source .testflight.env
  set +o allexport
fi

if [[ -z "${APP_STORE_CONNECT_KEY_ID:-}" || -z "${APP_STORE_CONNECT_ISSUER_ID:-}" ]]; then
  echo "Missing App Store Connect API credentials." >&2
  echo "Create ios-native/.testflight.env with:" >&2
  echo "  APP_STORE_CONNECT_KEY_ID=<10-char key id>" >&2
  echo "  APP_STORE_CONNECT_ISSUER_ID=<issuer uuid>" >&2
  echo "and place the .p8 file at" >&2
  echo "  ~/.appstoreconnect/private_keys/AuthKey_${APP_STORE_CONNECT_KEY_ID:-XXX}.p8" >&2
  echo "See ios-native/TESTFLIGHT.md for full setup." >&2
  exit 1
fi

# Sanity-check the .p8 is in the right place. xcrun altool looks here
# (or in ~/.private_keys/) automatically.
p8_path="$HOME/.appstoreconnect/private_keys/AuthKey_${APP_STORE_CONNECT_KEY_ID}.p8"
if [[ ! -f "$p8_path" ]]; then
  echo "Can't find $p8_path — download the .p8 from App Store Connect" >&2
  echo "  Users and Access → Keys → click your key → Download API Key" >&2
  echo "  (Apple shows the key once; if missed, generate a new one.)" >&2
  exit 1
fi

# ── 2. Build number ─────────────────────────────────────────────────────
# Apple requires monotonically increasing build numbers per version.
# git rev-list count gives us a free monotonic counter.
build_number=$(git rev-list --count HEAD)
echo "→ Building build #$build_number"

# ── 3. Clean previous archive ───────────────────────────────────────────
rm -rf build

# ── 4. Archive ──────────────────────────────────────────────────────────
echo "→ Archiving..."
xcodebuild -project "$project" -scheme "$scheme" \
  -destination 'generic/platform=iOS' \
  -archivePath "$archive_path" \
  -allowProvisioningUpdates \
  CURRENT_PROJECT_VERSION="$build_number" \
  -quiet \
  archive

# ── 5. Export to IPA ────────────────────────────────────────────────────
echo "→ Exporting IPA..."
xcodebuild -exportArchive \
  -archivePath "$archive_path" \
  -exportPath "$export_path" \
  -exportOptionsPlist exportOptions.plist \
  -allowProvisioningUpdates \
  -quiet

if [[ ! -f "$ipa_path" ]]; then
  echo "Export succeeded but no IPA at $ipa_path" >&2
  ls "$export_path" >&2 || true
  exit 1
fi

# ── 6. Upload to App Store Connect ──────────────────────────────────────
echo "→ Uploading to App Store Connect (build #$build_number)..."
xcrun altool --upload-app \
  --type ios \
  --file "$ipa_path" \
  --apiKey "$APP_STORE_CONNECT_KEY_ID" \
  --apiIssuer "$APP_STORE_CONNECT_ISSUER_ID"

echo
echo "✓ Uploaded build #$build_number."
echo "  Apple is processing it now — typically 5–30 minutes."
echo "  When ready, you'll get an email and the build appears in"
echo "  TestFlight on your phone."
