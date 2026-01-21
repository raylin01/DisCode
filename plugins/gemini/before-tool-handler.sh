#!/bin/bash
#
# DisCode BeforeTool Handler for Gemini CLI
#
# This script is called by Gemini CLI's BeforeTool hook.
# It sends approval requests to the DisCode Runner Agent.
#

# Read hook input from stdin (Gemini CLI provides JSON via stdin)
HOOK_INPUT=$(cat)

# Extract relevant fields using jq
TOOL_NAME=$(echo "$HOOK_INPUT" | jq -r '.tool_name // empty')
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
TIMESTAMP=$(echo "$HOOK_INPUT" | jq -r '.timestamp // empty')

# Get tool_input as JSON (not raw string)
TOOL_INPUT=$(echo "$HOOK_INPUT" | jq '.tool_input // {}')

# Prepare approval request (format similar to Claude Code)
REQUEST=$(cat <<EOF
{
  "toolName": "$TOOL_NAME",
  "toolInput": $TOOL_INPUT,
  "sessionId": "$SESSION_ID",
  "timestamp": "$TIMESTAMP",
  "cli": "gemini"
}
EOF
)

# Get runner agent URL from environment or use default
RUNNER_AGENT_URL="${DISCODE_RUNNER_URL:-http://localhost:3122}"

# Send approval request to runner agent
RESPONSE=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$REQUEST" \
  --max-time 30 \
  "$RUNNER_AGENT_URL/approval" 2>&1)

CURL_EXIT_CODE=$?

if [ $CURL_EXIT_CODE -ne 0 ]; then
  # If we can't reach the runner agent, deny for safety
  echo "{\"decision\": \"deny\", \"reason\": \"Cannot reach runner agent at $RUNNER_AGENT_URL\", \"systemMessage\": \"DisCode: Runner agent unreachable\"}"
  exit 2
fi

# Parse response
ALLOW=$(echo "$RESPONSE" | jq -r '.allow // false')
MESSAGE=$(echo "$RESPONSE" | jq -r '.message // ""')

# Return decision to Gemini CLI
if [ "$ALLOW" = "true" ]; then
  echo "{\"decision\": \"allow\", \"systemMessage\": \"$MESSAGE\"}"
  exit 0
else
  echo "{\"decision\": \"deny\", \"reason\": \"$MESSAGE\", \"systemMessage\": \"$MESSAGE\"}"
  exit 2
fi
