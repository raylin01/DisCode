#!/bin/bash

# Update the Discord channel name and description via the Runner Agent

NAME="$1"
DESC="$2"

if [ -z "$NAME" ]; then
    echo "Usage: $0 <channel_name> [description]"
    exit 1
fi

# Use environment variables injected by the runner
# NOTE: DISCODE_HTTP_PORT is the local runner agent's HTTP server (default: 3122)
# This is different from DISCODE_BOT_URL which is the Discord bot's WebSocket (ws://localhost:8080)

# Fallback: Try to load from .discode/env.sh if not set
if [ -z "$DISCODE_HTTP_PORT" ]; then
    if [ -f "env.sh" ]; then
        source env.sh
    elif [ -f ".discode/env.sh" ]; then
        source .discode/env.sh
    fi
fi

if [ -z "$DISCODE_HTTP_PORT" ] || [ -z "$DISCODE_SESSION_ID" ]; then
    echo "Error: DISCODE_HTTP_PORT or DISCODE_SESSION_ID not set."
    exit 1
fi

# Try Python first (most reliable), then fallback to curl+jq
if command -v python3 &> /dev/null; then
    python3 -c "
import http.client
import json
import os
import sys

name = sys.argv[1]
desc = sys.argv[2] if len(sys.argv) > 2 else ''
session_id = os.environ.get('DISCODE_SESSION_ID', '')
port = int(os.environ.get('DISCODE_HTTP_PORT', '3122'))

data = {
    'type': 'discord_action',
    'action': 'update_channel',
    'sessionId': session_id,
    'name': name,
    'description': desc
}

conn = http.client.HTTPConnection('127.0.0.1', port)
headers = {'Content-Type': 'application/json'}

try:
    conn.request('POST', '/session-event', json.dumps(data), headers)
    response = conn.getresponse()

    if 200 <= response.status < 300:
        print('Channel updated.')
        sys.exit(0)
    else:
        print(f'Error: Failed with status code {response.status}', file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f'Error: Failed to connect to runner agent at port {port}. Is it running?', file=sys.stderr)
    sys.exit(1)
finally:
    conn.close()
" "$NAME" "$DESC"

else
    # Fallback to curl with jq
    if ! curl -f -s -X POST "http://127.0.0.1:$DISCODE_HTTP_PORT/session-event" \
         -H "Content-Type: application/json" \
         -d "{
               \"type\": \"discord_action\",
               \"action\": \"update_channel\",
               \"sessionId\": \"$DISCODE_SESSION_ID\",
               \"name\": $(jq -n --arg name "$NAME" '$name'),
               \"description\": $(jq -n --arg desc "$DESC" '$desc')
             }"; then
        echo "Error: Failed to update channel. Runner agent may be unreachable or disconnected."
        exit 1
    fi
    echo "Channel updated."
fi
