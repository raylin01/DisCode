# DisCode Plugins

This directory contains the CLI plugins for Claude Code and Gemini CLI.

## Structure

```
plugins/
├── claude/          # Claude Code plugin files
├── gemini/          # Gemini CLI plugin files
└── README.md        # This file
```

## Installation

Run the installation script from the root of the DisCode repository:

```bash
./install-plugins.sh
```

This will:
1. Install Claude Code plugin to `~/.claude/plugins/discode/`
2. Install Gemini CLI plugin to `~/.gemini/discode/`
3. Configure Gemini CLI hooks (if Gemini is installed)

## Manual Installation

### Claude Code Plugin

Copy files to:
```bash
mkdir -p ~/.claude/plugins/discode
cp plugins/claude/* ~/.claude/plugins/discode/
chmod +x ~/.claude/plugins/discode/*.js
```

The plugin will be automatically loaded by Claude Code.

### Gemini CLI Plugin

Copy files to:
```bash
mkdir -p ~/.gemini/discode
cp plugins/gemini/* ~/.gemini/discode/
chmod +x ~/.gemini/discode/*.sh
```

Then update `~/.gemini/settings.json`:
```json
{
  "hooks": {
    "BeforeTool": "~/.gemini/discode/before-tool-handler.sh",
    "SessionStart": "~/.gemini/discode/session-handler.sh",
    "SessionEnd": "~/.gemini/discode/session-handler.sh"
  }
}
```

## Plugin Files

### Claude Code Plugin (`plugins/claude/`)

- `hooks.json` - Hook configuration
- `approval-handler.js` - Handles tool approval requests
- `session-handler.js` - Handles session lifecycle events
- `README.md` - Detailed documentation

### Gemini CLI Plugin (`plugins/gemini/`)

- `before-tool-handler.sh` - Handles tool approval requests
- `session-handler.sh` - Handles session lifecycle events
- `README.md` - Detailed documentation

## How Plugins Work

### Approval Flow

1. User runs CLI command that requires tool use
2. CLI triggers the hook (PreToolUse for Claude, BeforeTool for Gemini)
3. Plugin sends approval request to Runner Agent (HTTP POST to `localhost:3122/approval`)
4. Runner Agent forwards request to Discord bot via WebSocket
5. Discord bot shows approval UI to user with [Allow/Deny] buttons
6. User clicks button
7. Decision flows back: Discord bot → Runner Agent → Plugin → CLI
8. CLI continues or stops based on decision

### Session Events

Plugins also send session start/end events to track usage.

## Configuration

Plugins use the following environment variables:

- `DISCORDE_RUNNER_URL` - Runner Agent URL (default: `http://localhost:3122`)
- `DISCORDE_RUNNER_ID` - Runner ID (optional, for multi-runner setups)

## Troubleshooting

### Plugin not loading

**Claude Code:**
- Check file permissions: `ls -la ~/.claude/plugins/discode/`
- Verify `hooks.json` is valid JSON
- Check Claude Code logs for errors

**Gemini CLI:**
- Check file permissions: `ls -la ~/.gemini/discode/`
- Verify hooks are in `settings.json`
- Test scripts manually: `~/.gemini/discode/before-tool-handler.sh`

### Approvals timing out

- Verify Runner Agent is running: `curl http://localhost:3122/`
- Check Runner Agent logs for errors
- Verify Discord bot WebSocket is connected

### Can't reach Runner Agent

- Check Runner Agent is started
- Verify port 3122 is not in use
- Check firewall settings

## Development

To modify plugins:

1. Edit files in `plugins/claude/` or `plugins/gemini/`
2. Run `./install-plugins.sh` to reinstall
3. Restart CLI to test changes

## Uninstallation

### Claude Code
```bash
rm -rf ~/.claude/plugins/discode
```

### Gemini CLI
```bash
rm -rf ~/.gemini/discode
# Then manually remove hooks from ~/.gemini/settings.json
```

## Support

For issues or questions:
- Check main README.md
- Check logs in Discord bot and Runner Agent
- Open an issue on GitHub
