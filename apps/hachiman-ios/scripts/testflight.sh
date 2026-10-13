#!/usr/bin/env bash
# Builds the app with the production endpoints, archives it, and uploads it to TestFlight.
# The same steps as the `testflight` job of .github/workflows/ios.yml, on this Mac.
# Run it with `pnpm -F @hachiman/hachiman-ios testflight`, which loads the repo-root .env.
#
# Needs (root .env, section "iOS release"):
#   IOS_TEAM_ID         the Apple Developer team ID
#   IOS_RELEASE_DOMAIN  the production domain (https://<domain>/api, wss://<domain>/gateway)
#   IOS_ASC_KEY_ID      the App Store Connect API key ID (Admin role: the export uses cloud signing)
#   IOS_ASC_ISSUER_ID   the issuer ID
#   IOS_ASC_KEY_PATH    optional; default ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8
#   IOS_BUNDLE_ID       optional; default app.hachiman.ios
# and Xcode (not only the Command Line Tools): set DEVELOPER_DIR if xcode-select points elsewhere.
set -euo pipefail
cd "$(dirname "$0")/.."

missing=()
for name in IOS_TEAM_ID IOS_RELEASE_DOMAIN IOS_ASC_KEY_ID IOS_ASC_ISSUER_ID; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "error: set ${missing[*]} in the repo-root .env (see .env.example, section iOS release)" >&2
  exit 1
fi
key="${IOS_ASC_KEY_PATH:-$HOME/.appstoreconnect/private_keys/AuthKey_${IOS_ASC_KEY_ID}.p8}"
key="${key/#\~/$HOME}"
[ -f "$key" ] || { echo "error: no API key at $key" >&2; exit 1; }
xcodebuild -version >/dev/null 2>&1 || {
  echo "error: xcodebuild needs Xcode. Set DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer" >&2
  exit 1
}

# The production endpoints. They beat the dev VITE_* values of the root .env, which Vite also reads.
export VITE_TAKUSEN_OIDC_ISSUER="https://${IOS_RELEASE_DOMAIN}/api/oidc"
export VITE_TAKUSEN_API_BASE="https://${IOS_RELEASE_DOMAIN}/api"
export VITE_HACHIMAN_GATEWAY_URL="wss://${IOS_RELEASE_DOMAIN}/gateway"
# Always rising, and above the run numbers of the CI builds.
build="$(date -u +%y%m%d%H%M)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
auth=(-allowProvisioningUpdates -authenticationKeyPath "$key"
  -authenticationKeyID "$IOS_ASC_KEY_ID" -authenticationKeyIssuerID "$IOS_ASC_ISSUER_ID")

echo "==> web bundle for $IOS_RELEASE_DOMAIN"
pnpm build
xcodegen generate

echo "==> archive (build $build)"
xcodebuild archive -project Hachiman.xcodeproj -scheme Hachiman -configuration Release \
  -destination 'generic/platform=iOS' -archivePath "$work/Hachiman.xcarchive" \
  DEVELOPMENT_TEAM="$IOS_TEAM_ID" HACHIMAN_BUNDLE_ID="${IOS_BUNDLE_ID:-app.hachiman.ios}" \
  CURRENT_PROJECT_VERSION="$build" "${auth[@]}" -quiet

echo "==> upload to TestFlight"
cp ExportOptions.plist "$work/ExportOptions.plist"
/usr/libexec/PlistBuddy -c "Add :teamID string $IOS_TEAM_ID" "$work/ExportOptions.plist"
xcodebuild -exportArchive -archivePath "$work/Hachiman.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" -exportPath "$work/export" "${auth[@]}"
echo "==> uploaded build $build. App Store Connect processes it before testers get it."
