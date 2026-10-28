#!/usr/bin/env bash
# Build an unsigned Release .ipa for sideloading tools that re-sign with your
# own Apple ID (SideStore, AltStore, Sideloadly). They renew the 7-day free
# signature in the background, so the phone does not need the Mac weekly.
#
#   ios/scripts/build-unsigned-ipa.sh            # → ios/build/HappyClaw-<version>-unsigned.ipa
#   ios/scripts/build-unsigned-ipa.sh <out.ipa>
#
# The bundle id comes from Config/Local.xcconfig when present; re-signing
# tools usually rewrite it anyway.
set -euo pipefail

cd "$(dirname "$0")/.."

derived=build/DerivedData-unsigned
log="$(mktemp -t happyclaw-ipa-build)"
echo "Building Release without signing (log: $log)…"
if ! xcodebuild -project HappyClaw.xcodeproj -scheme HappyClaw -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath "$derived" \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY= \
  build >"$log" 2>&1; then
  grep -E "error:" "$log" | sort -u | head -20 >&2
  exit 1
fi

app="$derived/Build/Products/Release-iphoneos/HappyClaw.app"
version="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")"
build="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")"
out="${1:-build/HappyClaw-$version-$build-unsigned.ipa}"
case "$out" in /*) ;; *) out="$PWD/$out" ;; esac

staging="$(mktemp -d -t happyclaw-ipa)"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/Payload"
cp -R "$app" "$staging/Payload/"
rm -f "$out"
(cd "$staging" && /usr/bin/zip -qry "$out" Payload)

echo "Wrote $out ($(du -h "$out" | cut -f1))"
