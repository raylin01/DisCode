# DisCode - Discord Remote CLI Control

**Version:** 0.3.0

Control Claude Code, Gemini CLI, and Tmux terminals through Discord with interactive approvals, rich embeds, and action tracking.

## Features

- **Remote CLI Control**: Interact with Claude Code and Gemini CLI from Discord
- **Interactive Approvals**: Approve or deny tool usage requests through Discord buttons
- **Terminal Watching**: Monitor and interact with tmux sessions in real-time
- **Multi-Runner Support**: Manage multiple machines from a single Discord server
- **Private Sessions**: Each CLI session gets its own private thread
- **Secure Authentication**: Token-based runner registration

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Discord Bot (Central Server)                                │
│ - Slash commands (/generate-token, /create-session)        │
│ - WebSocket server for runners                              │
│ - Discord buttons for approvals                             │
│ - YAML-based storage                                        │
└────────────────────┬────────────────────────────────────────┘
                     │ WebSocket
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ Runner Agent (on user machine)                              │
│ - WebSocket client to Discord bot                           │
│ - HTTP server for CLI plugins                               │
│ - Manages CLI processes                                     │
└────────────────────┬────────────────────────────────────────┘
                     │ HTTP
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ CLI Plugin (Claude Code or Gemini CLI)                     │
│ - Hooks to intercept tool usage                             │
│ - Sends approval requests to Runner Agent                  │
│ - Respects allow/deny decisions                             │
└─────────────────────────────────────────────────────────────┘
```

## Project Structure

```
DisCode/
├── discord-bot/          # Discord bot source
├── runner-agent/         # Runner Agent source
├── shared/               # Shared types and utilities
├── plugins/              # CLI plugin installation scripts
└── hooks/                # Plugin hooks
```

## Quick Start

### 1. Set Up Discord Bot

1. Create a Discord Application at https://discord.com/developers/applications
2. Enable bot with required scopes:
   - `bot`
   - `applications.commands`
3. Get your bot token and client ID
4. Invite bot to your server with these scopes:
   - `bot`
   - `applications.commands`

### 2. Configure Environment Variables

**Discord Bot:**
```bash
cd discord-bot
cp .env.example .env
```

Edit `.env`:
```bash
DISCORDE_DISCORD_TOKEN=your_bot_token_here
DISCORDE_DISCORD_CLIENT_ID=your_client_id_here
DISCORDE_WS_PORT=8080
DISCORDE_STORAGE_PATH=./data
```

**Runner Agent:**
```bash
cd runner-agent
cp .env.example .env
```

Edit `.env`:
```bash
DISCORDE_TOKEN=token_from_discord_bot
DISCORDE_BOT_URL=ws://localhost:8080
DISCORDE_RUNNER_NAME=my-machine
DISCORDE_CLI_TYPE=claude  # or 'gemini'
DISCORDE_HTTP_PORT=3000
```

### 3. Start Discord Bot

```bash
cd discord-bot
bun install
bun run src/index.ts
```

Expected output:
```
✅ Discord bot logged in as DisCodeBot#1234
✅ Successfully reloaded application (/) commands.
✅ WebSocket server listening on port 8080
```

### 4. Generate Token in Discord

In your Discord server:
```
/generate-token
```

Copy the token and add it to your Runner Agent's `.env` file.

### 5. Install CLI Plugins

**Install Claude Code Plugin:**
```bash
bun run install-plugins.sh
```

Or manually install plugins from the `plugins/` directory.

**Install Gemini CLI Plugin:**
```bash
cp hooks/gemini/before-tool-handler.sh ~/.gemini/discode/
cp hooks/gemini/session-handler.sh ~/.gemini/discode/
```

Then add to `~/.gemini/settings.json`:
```json
{
  "hooks": {
    "BeforeTool": "~/.gemini/discode/before-tool-handler.sh",
    "OnSessionStart": "~/.gemini/discode/session-handler.sh"
  }
}
```

### 6. Start Runner Agent

```bash
cd runner-agent
bun install
bun run src/index.ts
```

Expected output:
```
╔════════════════════════════════════════════════════════════╗
║           DisCode Runner Agent v0.1.0                     ║
╠════════════════════════════════════════════════════════════╣
║  Runner ID: runner_my-machine_1234567890                  ║
║  Runner Name: my-machine                                   ║
║  CLI Type: claude                                          ║
║  HTTP Server: http://localhost:3000                        ║
║  Bot WebSocket: ws://localhost:8080                        ║
╚════════════════════════════════════════════════════════════╝

✅ Connected to Discord bot
```

### 7. Use Discord Commands

Available commands:
```
/list-runners                # List all connected runners
/create-session              # Start a new CLI session
/share-runner @user <id>     # Share a runner with another user
/terminals                   # List active tmux terminals
/watch <session_id>          # Watch a specific terminal
/unwatch <session_id>        # Stop watching a terminal
/interrupt <session_id>      # Send Ctrl+C to a terminal
```

## Usage Example

1. **Create Session:**
   ```
   /create-session
   ```
   → Creates a private thread

2. **Use Claude Code:**
   ```
   claude --print
   ```
   → Send prompt: "Read package.json"

3. **Approval Request:**
   Discord shows:
   ```
   🔔 Tool Use Approval Required
   Runner: my-machine
   Tool: Read
   Input: { "file_path": "package.json" }

   [Allow] [Deny]
   ```

4. **Click Button:**
   → Runner Agent receives decision
   → Claude Code continues or stops

## Tmux Setup

The Terminal Watch feature (`/terminals` and `/watch`) requires tmux to be running on your machine.

### Installation

```bash
# macOS
brew install tmux

# Ubuntu/Debian
sudo apt-get install tmux
```

### Starting a Session

```bash
tmux new -s my-work-session
```

This session will appear in DisCode via `/terminals`.

### Auto-Start (Optional)

Add to your `~/.zshrc` or `~/.bashrc`:

```bash
# Start tmux if it's not running, or attach to the last session
if command -v tmux &> /dev/null && [ -n "$PS1" ] && [[ ! "$TERM" =~ screen ]] && [[ ! "$TERM" =~ tmux ]] && [ -z "$TMUX" ]; then
  tmux attach -t default || tmux new -s default
fi
```

## Features

### Discord Bot
- Slash commands for all operations
- WebSocket server for runner connections
- Discord button components for approvals
- Private thread management per session
- Token-based authentication
- YAML-based storage

### Runner Agent
- WebSocket client to Discord bot
- HTTP server for CLI plugin communication
- Auto-reconnect on disconnect
- Heartbeat monitoring (30s interval)
- Graceful shutdown
- Tmux integration for terminal monitoring
- Automatic session discovery

### CLI Plugins
- Claude Code hooks (PreToolUse, SessionStart, SessionEnd)
- Gemini CLI hooks (BeforeTool, SessionStart, SessionEnd)
- HTTP communication with Runner Agent
- Safe defaults (deny if unreachable)

## Environment Variables

### Discord Bot

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORDE_DISCORD_TOKEN` | ✅ | - | Discord bot token |
| `DISCORDE_DISCORD_CLIENT_ID` | ✅ | - | Discord application client ID |
| `DISCORDE_WS_PORT` | ❌ | 8080 | WebSocket server port |
| `DISCORDE_STORAGE_PATH` | ❌ | ./data | YAML storage directory |

### Runner Agent

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORDE_TOKEN` | ✅ | - | Token from Discord bot |
| `DISCORDE_BOT_URL` | ❌ | ws://localhost:8080 | Discord bot WebSocket URL |
| `DISCORDE_RUNNER_NAME` | ❌ | local-runner | Human-readable runner name |
| `DISCORDE_CLI_TYPE` | ❌ | claude | CLI type (claude/gemini) |
| `DISCORDE_HTTP_PORT` | ❌ | 3000 | HTTP server port for plugin |
| `DISCORDE_TMUX_POLLING` | ❌ | true | Enable polling for new tmux sessions |

## Storage

YAML files are stored in `./data` (or `DISCORDE_STORAGE_PATH`):

- `users.yaml` - User tokens and runner associations
- `runners.yaml` - Runner registration data
- `sessions.yaml` - Active session data

## Troubleshooting

### Discord Bot Issues

**Bot not responding:**
- Check token is correct
- Verify bot has `bot` and `applications.commands` scopes
- Check console for errors

**Commands not showing:**
- Run: `bun run src/register-commands.ts`
- Wait 1-5 minutes for Discord to update
- Try restarting Discord

### Runner Agent Issues

**Can't connect to bot:**
- Verify bot WebSocket server is running
- Check `DISCORDE_BOT_URL` is correct
- Check token is valid

**Approvals timing out:**
- Check Runner Agent is still connected
- Verify Discord bot WebSocket is running
- Check network connectivity

### CLI Plugin Issues

**Approvals not triggering:**
- Verify Runner Agent is running on port 3000
- Check plugin is installed correctly
- Test with: `curl http://localhost:3000/`

**Claude Code ignores decisions:**
- Check hooks.json is correct
- Verify plugin is in right directory: `~/.claude/plugins/discode/`
- Check approval-handler.js is executable

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

MIT License - See LICENSE file for details

## Support

For issues or questions:
- Check the troubleshooting section above
- Examine logs in both Discord bot and Runner Agent
- Review configuration files

---

**Version:** 0.3.0
**Status:** ✅ Stable
