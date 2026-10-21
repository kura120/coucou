#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/peika-diff-engine.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
swiftc NotchBuddy/Sources/PeikaKit/DiffEngine.swift \
    tests/DiffEngineTests.swift -o "$TEST_DIR/diff-engine-tests"
"$TEST_DIR/diff-engine-tests"
