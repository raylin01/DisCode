#!/bin/bash
#
# spawn-thread.sh - Spawn a new CLI thread in a specific folder
#
# Usage: spawn-thread.sh <folder_path> <cli_type> [initial_message]
#
# Arguments:
#   folder_path     - Path to the working directory for the new thread
#   cli_type        - CLI to use: "claude", "gemini", or "auto"
#   initial_message - Optional first message to send to the new session
#

set -e

FOLDER_PATH="${1:-}"
CLI_TYPE="${2:-auto}"
INITIAL_MESSAGE="${3:-}"

# Validate folder path
if [ -z "$FOLDER_PATH" ]; then
    echo "Error: folder_path is required"
    echo "Usage: spawn-thread.sh <folder_path> <cli_type> [initial_message]"
    exit 1
fi

# Get the runner agent HTTP port
PORT="${DISCODE_HTTP_PORT:-3122}"

# Build JSON payload
PAYLOAD=$(cat <<EOF
{
    "folder": "$FOLDER_PATH",
    "cliType": "$CLI_TYPE",
    "message": "$INITIAL_MESSAGE"
}
EOF
)

# Call the runner agent's spawn-thread endpoint
RESPONSE=$(curl -s -X POST "http://localhost:${PORT}/spawn-thread" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD")

# Check response
if echo "$RESPONSE" | grep -q "error"; then
    echo "Error spawning thread: $RESPONSE"
    exit 1
fi

echo "Thread spawn request sent successfully"
echo "$RESPONSE"
