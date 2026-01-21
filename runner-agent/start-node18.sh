#!/bin/bash
# Start runner agent with Node v18 and node-pty support

export PATH="$HOME/.nvm/versions/node/v18.15.0/bin:$PATH"
export DISCODE_BOT_URL="ws://localhost:8080"

cd "$(dirname "$0")"

echo "Using Node v18 for node-pty support..."
node --version

# Load .env file
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
fi

# Re-export DISCODE_BOT_URL to override .env if needed
export DISCODE_BOT_URL="ws://localhost:8080"

exec npx tsx src/index.ts
