#!/usr/bin/env bash
# Build the shell with your Apple Development identity and install it on a
# connected/paired iPhone. Re-run to renew a 7-day Personal Team signature.
#
#   ios/scripts/install-device.sh                 # first paired iPhone
#   ios/scripts/install-device.sh <device-udid>   # a specific device
#
# Requires ios/Config/Local.xcconfig (see Local.xcconfig.example).
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f Config/Local.xcconfig ]]; then
  echo "Missing ios/Config/Local.xcconfig — copy Config/Local.xcconfig.example and set DEVELOPMENT_TEAM / HAPPYCLAW_BUNDLE_ID." >&2
  exit 1
fi

device="${1:-}"
if [[ -z "$device" ]]; then
  devices_json="$(mktemp -t happyclaw-devices)"
  xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1 || true
  device="$(python3 -I - "$devices_json" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
for d in data.get("result", {}).get("devices", []):
    props = d.get("hardwareProperties", {})
    state = d.get("connectionProperties", {}).get("tunnelState", "")
    # devicectl also lists booted Simulators (reality == "simulated").
    if (props.get("deviceType") == "iPhone" and props.get("reality") == "physical"
            and state != "unavailable"):
        print(props.get("udid", "")); break
PY
)"
fi
if [[ -z "$device" ]]; then
  echo "No available iPhone. Connect it by cable (or same Wi-Fi after pairing), unlock it, then check:" >&2
  echo "  xcrun devicectl list devices" >&2
  exit 1
fi

log="$(mktemp -t happyclaw-ios-build)"
echo "Building (log: $log)…"
if ! xcodebuild -project HappyClaw.xcodeproj -scheme HappyClaw -configuration Debug \
  -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  -allowProvisioningUpdates build >"$log" 2>&1; then
  grep -E "error:" "$log" | sort -u | head -20 >&2
  exit 1
fi

app="build/DerivedData/Build/Products/Debug-iphoneos/HappyClaw.app"
bundle_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Info.plist")"
expires="$(security cms -D -i "$app/embedded.mobileprovision" | plutil -extract ExpirationDate raw -)"

echo "Installing $bundle_id on $device (profile expires $expires)…"
xcrun devicectl device install app --device "$device" "$app"
xcrun devicectl device process launch --device "$device" "$bundle_id" || true
