#!/usr/bin/env bash
# Naia ADK — start server + dashboard (Linux/macOS)
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting Naia ADK..."
echo ""
echo "  Server:    http://localhost:3141"
echo "  Dashboard: http://localhost:3142"
echo ""

exec pnpm dev
