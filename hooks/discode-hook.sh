#!/bin/bash
# DisCode Hook - Captures Claude Code events for Discord integration
#
# This script is called by Claude Code hooks and:
# 1. Reads the hook input from stdin
# 2. Transforms it into our event format (optional, we mostly pass raw)
# 3. Notifies the local Runner Agent via HTTP
#
# Installed to: ~/.discode/hooks/discode-hook.sh

set -e

# =============================================================================
# Configuration
# =============================================================================

HOOK_SERVER_URL="${DISCODE_HOOK_URL:-http://localhost:3122/hook}"
# Use curl or wget
CURL="curl"
if ! command -v curl &> /dev/null; then
    if command -v wget &> /dev/null; then
        CURL="wget"
    else
        # No curl or wget, fail silently (don't break Claude)
        exit 0
    fi
fi

# =============================================================================
# Read and Parse Input
# =============================================================================

# Read stdin into a variable
input=$(cat)

# DEBUG: Log to file
echo "[$(date)] Hook triggered" >> /tmp/discode-hook.log
# echo "$input" >> /tmp/discode-hook.log

# fire and forget to the server so we don't block Claude
if [ "$CURL" = "curl" ]; then
    curl -v -X POST "$HOOK_SERVER_URL" \
        -H "Content-Type: application/json" \
        -d "$input" \
        --connect-timeout 1 \
        --max-time 2 \
        >> /tmp/discode-hook.log 2>&1 &
else
    # wget version
    wget -qO- --post-data="$input" \
        --header="Content-Type: application/json" \
        --timeout=2 \
        --tries=1 \
        "$HOOK_SERVER_URL" >/dev/null 2>&1 &
fi

exit 0
