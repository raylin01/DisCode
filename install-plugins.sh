#!/bin/bash
#
# DisCode Plugin Installation Script
#
# This script installs the Claude Code and Gemini CLI plugins
# to their respective directories.
#

set -e

echo "🔧 Installing DisCode Plugins..."
echo ""

# Get the script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Claude Code Plugin
echo "📦 Installing Claude Code Plugin..."
CLAUDE_PLUGIN_DIR="$HOME/.claude/plugins/discode"

mkdir -p "$CLAUDE_PLUGIN_DIR"

# Copy files
cp "$SCRIPT_DIR/plugins/claude/"*.js "$CLAUDE_PLUGIN_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/plugins/claude/"*.json "$CLAUDE_PLUGIN_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/plugins/claude/"*.sh "$CLAUDE_PLUGIN_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/plugins/claude/"*.md "$CLAUDE_PLUGIN_DIR/" 2>/dev/null || true

# Make scripts executable
chmod +x "$CLAUDE_PLUGIN_DIR/"*.js 2>/dev/null || true
chmod +x "$CLAUDE_PLUGIN_DIR/"*.sh 2>/dev/null || true

echo "✅ Claude Code plugin installed to: $CLAUDE_PLUGIN_DIR"
echo ""

# Gemini CLI Plugin
echo "📦 Installing Gemini CLI Plugin..."
GEMINI_PLUGIN_DIR="$HOME/.gemini/discode"

mkdir -p "$GEMINI_PLUGIN_DIR"

# Copy files
cp "$SCRIPT_DIR/plugins/gemini/"*.sh "$GEMINI_PLUGIN_DIR/" 2>/dev/null || true
cp "$SCRIPT_DIR/plugins/gemini/"*.md "$GEMINI_PLUGIN_DIR/" 2>/dev/null || true

# Make scripts executable
chmod +x "$GEMINI_PLUGIN_DIR/"*.sh 2>/dev/null || true

echo "✅ Gemini CLI plugin installed to: $GEMINI_PLUGIN_DIR"
echo ""

# Update Gemini settings.json to add hooks
echo "🔧 Updating Gemini CLI settings..."
GEMINI_SETTINGS="$HOME/.gemini/settings.json"

if [ -f "$GEMINI_SETTINGS" ]; then
  # Backup existing settings
  cp "$GEMINI_SETTINGS" "$GEMINI_SETTINGS.backup"

  # Check if hooks already exist
  if ! grep -q "discode" "$GEMINI_SETTINGS"; then
    # Add hooks using Node.js (more reliable than jq for JSON manipulation)
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$GEMINI_SETTINGS', 'utf8'));
      settings.hooks = settings.hooks || {};
      settings.hooks.BeforeTool = '~/.gemini/discode/before-tool-handler.sh';
      settings.hooks.SessionStart = '~/.gemini/discode/session-handler.sh';
      settings.hooks.SessionEnd = '~/.gemini/discode/session-handler.sh';
      fs.writeFileSync('$GEMINI_SETTINGS', JSON.stringify(settings, null, 2));
    "
    echo "✅ Gemini hooks added to settings.json"
  else
    echo "ℹ️  Gemini hooks already configured"
  fi
else
  echo "⚠️  Gemini settings.json not found. You may need to configure hooks manually."
fi

echo ""
echo "🎉 Plugin installation complete!"
echo ""
echo "Next steps:"
echo "  1. Start the Discord bot: cd discord-bot && bun run src/index.ts"
echo "  2. Generate a token in Discord: /generate-token"
echo "  3. Configure your runner: cd runner-agent && cp .env.example .env"
echo "  4. Add the token to runner-agent/.env"
echo "  5. Start the runner agent: cd runner-agent && bun run src/index.ts"
echo ""
echo "For multi-CLI support, set DISCODE_CLI_TYPES in runner-agent/.env:"
echo "  DISCODE_CLI_TYPES=claude,gemini"
echo ""
