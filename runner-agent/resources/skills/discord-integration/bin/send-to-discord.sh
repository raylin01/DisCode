#!/bin/bash

# Send a message to the Discord channel via the Runner Agent
# Usage: send-to-discord.sh [options] "Message content"
# Options:
#   --title "Embed Title"
#   --color "hex_color" (e.g., "0x00FF00" or "green")
#   --description "Embed Description" (overrides content if used in embed)

CONTENT=""
TITLE=""
COLOR=""
DESCRIPTION=""
FILE_PATH=""

# Parse arguments
while [[ "$#" -gt 0 ]]; do
    case $1 in
        --title) TITLE="$2"; shift ;;
        --color) COLOR="$2"; shift ;;
        --description) DESCRIPTION="$2"; shift ;;
        --file|-f) FILE_PATH="$2"; shift ;;
        *) CONTENT="$1" ;;
    esac
    shift
done

if [ -z "$CONTENT" ] && [ -z "$TITLE" ] && [ -z "$DESCRIPTION" ] && [ -z "$FILE_PATH" ]; then
    echo "Usage: $0 [--title \"Title\"] [--color \"Red\"] \"Message content\""
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

# Map common color names to hex (bash 3 compatible - use tr for lowercase)
COLOR_LOWER=$(echo "$COLOR" | tr '[:upper:]' '[:lower:]')
case "$COLOR_LOWER" in
    red) COLOR_HEX="0xFF0000" ;;
    green) COLOR_HEX="0x00FF00" ;;
    blue) COLOR_HEX="0x0000FF" ;;
    yellow) COLOR_HEX="0xFFFF00" ;;
    orange) COLOR_HEX="0xFFA500" ;;
    purple) COLOR_HEX="0x800080" ;;
    white) COLOR_HEX="0xFFFFFF" ;;
    black) COLOR_HEX="0x000000" ;;
    *) COLOR_HEX="$COLOR" ;;
esac

# Try Python first (most reliable), then Node
if command -v python3 &> /dev/null; then
    python3 -c "
import http.client
import json
import sys
import base64
import os

content = sys.argv[1] if len(sys.argv) > 1 else None
title = sys.argv[2] if len(sys.argv) > 2 else None
color_str = sys.argv[3] if len(sys.argv) > 3 else None
description = sys.argv[4] if len(sys.argv) > 4 else None
file_path = sys.argv[5] if len(sys.argv) > 5 else None
session_id = os.environ.get('DISCODE_SESSION_ID', '')
port = int(os.environ.get('DISCODE_HTTP_PORT', '3122'))

data = {
    'type': 'discord_action',
    'action': 'send_message',
    'sessionId': session_id,
    'content': content,
    'embeds': [],
    'files': []
}

# Build embed
if title or description or color_str:
    embed = {}
    if title:
        embed['title'] = title
    if description:
        embed['description'] = description
    if color_str:
        hex_str = color_str.replace('0x', '').replace('#', '')
        try:
            embed['color'] = int(hex_str, 16)
        except:
            pass
    if embed:
        data['embeds'].append(embed)

# Process file
if file_path:
    try:
        with open(file_path, 'rb') as f:
            file_content = f.read()
        import os.path
        filename = os.path.basename(file_path)
        data['files'].append({
            'name': filename,
            'content': base64.b64encode(file_content).decode('utf-8')
        })
    except Exception as e:
        print(f'Error reading file: {e}', file=sys.stderr)
        sys.exit(1)

# Validate
if not data['content'] and not data['embeds'] and not data['files']:
    print('Error: Cannot send an empty message', file=sys.stderr)
    sys.exit(1)

# Send request
conn = http.client.HTTPConnection('127.0.0.1', port)
headers = {'Content-Type': 'application/json'}

try:
    conn.request('POST', '/session-event', json.dumps(data), headers)
    response = conn.getresponse()

    if 200 <= response.status < 300:
        sys.exit(0)
    else:
        print(f'Request failed with status code: {response.status}', file=sys.stderr)
        sys.exit(1)
except Exception as e:
    print(f'Error: Failed to connect to runner agent at port {port}. Is it running?', file=sys.stderr)
    sys.exit(1)
finally:
    conn.close()
" "$CONTENT" "$TITLE" "$COLOR_HEX" "$DESCRIPTION" "$FILE_PATH"

elif command -v node &> /dev/null; then
    node -e "
const http = require('http');
const fs = require('fs');
const path = require('path');

const content = process.argv[2] ? process.argv[2].trim() : undefined;
const title = process.argv[3] ? process.argv[3].trim() : undefined;
const colorStr = process.argv[4] ? process.argv[4].trim() : undefined;
const description = process.argv[5] ? process.argv[5].trim() : undefined;
const filePath = process.argv[6] ? process.argv[6].trim() : undefined;

const data = {
    type: 'discord_action',
    action: 'send_message',
    sessionId: process.env.DISCODE_SESSION_ID,
    content: content,
    embeds: [],
    files: []
};

// Build embed
if (title || description || colorStr) {
    const embed = {};
    if (title) embed.title = title;
    if (description) embed.description = description;
    if (colorStr) {
        const hex = colorStr.replace(/^0x/, '').replace(/^#/, '');
        embed.color = parseInt(hex, 16) || 0;
    }
    if (Object.keys(embed).length > 0) {
        data.embeds.push(embed);
    }
}

// Process file
if (filePath) {
    try {
        if (fs.existsSync(filePath)) {
            const fileBuffer = fs.readFileSync(filePath);
            const fileName = path.basename(filePath);
            data.files.push({
                name: fileName,
                content: fileBuffer.toString('base64')
            });
        } else {
            console.error('File not found:', filePath);
            process.exit(1);
        }
    } catch (err) {
        console.error('Error reading file:', err);
        process.exit(1);
    }
}

// Validate
if (!data.content && data.embeds.length === 0 && data.files.length === 0) {
    console.error('Error: Cannot send an empty message');
    process.exit(1);
}

const postData = JSON.stringify(data);
const port = parseInt(process.env.DISCODE_HTTP_PORT || '3122');

const options = {
    hostname: '127.0.0.1',
    port: port,
    path: '/session-event',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
    }
};

const req = http.request(options, (res) => {
    res.on('data', () => {});
    res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
            process.exit(0);
        } else {
            console.error('Request failed with status code:', res.statusCode);
            process.exit(1);
        }
    });
});

req.on('error', (e) => {
    const port = process.env.DISCODE_HTTP_PORT || '3122';
    console.error(`Error: Failed to connect to runner agent at port ${port}. Is it running?`);
    process.exit(1);
});

req.write(postData);
req.end();
" "$CONTENT" "$TITLE" "$COLOR_HEX" "$DESCRIPTION" "$FILE_PATH"

else
    echo "Error: Neither python3 nor node is available to run this script."
    exit 1
fi

