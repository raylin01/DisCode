#!/bin/bash
#
# DisCode Session Handler for Gemini CLI
#
# This script is called by Gemini CLI's SessionStart and SessionEnd hooks.
#

# Get the action from command line argument (start or end)
ACTION="$1"

if [ "$ACTION" != "start" ] && [ "$ACTION" != "end" ]; then
  echo "Usage: session-handler.sh <start|end>" >&2
  exit 1
fi

# Read hook input from stdin
HOOK_INPUT=$(cat)

# Extract relevant fields
SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Prepare session event
REQUEST=$(cat <<EOF
{
  "action": "$ACTION",
  "sessionId": "$SESSION_ID",
  "timestamp": "$TIMESTAMP",
  "cli": "gemini"
}
EOF
)

# Get runner agent URL
RUNNER_AGENT_URL="${DISCODE_RUNNER_URL:-http://localhost:3122}"

# Send session event to runner agent (fire and forget)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$REQUEST" \
  --max-time 5 \
  "$RUNNER_AGENT_URL/session-event" > /dev/null 2>&1

# Return empty response (Gemini CLI doesn't expect anything)
echo "{\"hookSpecificOutput\": {\"hookEventName\": \"Session${ACTION^}\"}}"
exit 0
