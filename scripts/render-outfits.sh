#!/bin/bash
# render-outfits.sh — compile and run the Peika outfit planche renderer
# NOT in CI. Run manually: bash scripts/render-outfits.sh
# Output: /tmp/peika-outfits.png

set -e
cd "$(dirname "$0")/.."

SDK=$(xcrun --sdk macosx --show-sdk-path)

echo "Compiling renderer..."
swiftc \
  -parse-as-library \
  -sdk "$SDK" \
  -target arm64-apple-macosx15.0 \
  NotchBuddy/Sources/PeikaKit/IslandScreenGeometry.swift \
  NotchBuddy/Sources/PeikaKit/IslandTypes.swift \
  NotchBuddy/Sources/PeikaKit/PeikaWardrobe.swift \
  NotchBuddy/Sources/PeikaKit/BotEngine.swift \
  NotchBuddy/Sources/PeikaKit/PeikaOutfitDrawing.swift \
  scripts/RenderOutfits.swift \
  -framework AppKit \
  -framework SwiftUI \
  -o /tmp/peika-render-outfits \
  2>&1

echo "Running renderer..."
/tmp/peika-render-outfits
echo "Opening..."
open /tmp/peika-outfits.png
