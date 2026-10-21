#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/peika-desktop.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc NotchBuddy/Sources/App/DesktopPeikaLogic.swift \
    tests/DesktopPeikaTests.swift -o "$TEST_DIR/desktop-peika-tests"
"$TEST_DIR/desktop-peika-tests"
