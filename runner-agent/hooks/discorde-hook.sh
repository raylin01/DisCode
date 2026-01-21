#!/bin/bash

# Configuration
URL="http://localhost:${DISCODE_HTTP_PORT:-3122}/hook"

# Arguments
EVENT_TYPE="$1"
PAYLOAD="$2"
SESSION_ID="${DISCODE_SESSION_ID}"

if [ -z "$SESSION_ID" ]; then
    exit 0
fi

# Use python3 for JSON handling which is generally available on macOS/Linux
# This is safer than string manipulation in bash
python3 -c "
import sys, json, urllib.request

url = '$URL'
event_type = '$EVENT_TYPE'
session_id = '$SESSION_ID'
raw_payload = sys.argv[1]

data = {
    'type': event_type,
    'sessionId': session_id
}

if event_type == 'UserPrompt':
    # Payload is the prompt string
    data['payload'] = raw_payload
elif event_type in ['PreToolUse', 'PostToolUse']:
    # Payload is JSON
    try:
        payload_json = json.loads(raw_payload)
        data['tool'] = payload_json.get('tool')
        data['toolInput'] = payload_json.get('input')
        # For PostToolUse, there might be 'output' or 'error'
        if 'output' in payload_json:
            data['toolOutput'] = payload_json.get('output')
        if 'error' in payload_json:
            data['toolError'] = payload_json.get('error')
    except:
        pass

json_data = json.dumps(data).encode('utf-8')

req = urllib.request.Request(url, json_data)
req.add_header('Content-Type', 'application/json')
try:
    urllib.request.urlopen(req, timeout=1)
except Exception as e:
    # Fail silently to not impact Claude
    pass
" "$PAYLOAD"
