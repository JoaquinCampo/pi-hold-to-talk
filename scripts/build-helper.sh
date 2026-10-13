#!/bin/sh
# Builds the speech helper and copies it to bin/, where the published package ships it.
# Requires Xcode command line tools and an Apple Silicon Mac.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
swift build -c release --arch arm64 --package-path "$root/helper"
mkdir -p "$root/bin"
cp "$root/helper/.build/release/pi-hold-to-talk-helper" "$root/bin/"
echo "Built $root/bin/pi-hold-to-talk-helper ($("$root/bin/pi-hold-to-talk-helper" --version))"
