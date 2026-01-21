# DisCode Claude Code Plugin

**Version:** 0.1.0
**Status:** Proof of Concept

This plugin enables Claude Code to communicate with the DisCode system, allowing tool use approvals to be routed through Discord for remote control.

## What It Does

The plugin intercepts Claude Code tool usage events and sends them to the DisCode Runner Agent:

1. **PreToolUse Hook**: Fires before any tool execution (Read, Write, Bash, etc.)
   - Sends approval request to Runner Agent
   - Waits for user decision from Discord
   - Returns allow/deny decision to Claude Code

2. **SessionStart Hook**: Fires when a new Claude Code session begins
   - Notifies Runner Agent of new session
   - Creates corresponding Discord thread

3. **SessionEnd Hook**: Fires when a Claude Code session ends
   - Notifies Runner Agent of session completion
   - Updates session status

## Installation

The plugin is automatically installed in `~/.claude/plugins/discode/`.

### Requirements

- **Bun** runtime (required for plugin scripts)
- Claude Code with hooks support
- DisCode Runner Agent running (or test server)

### Verify Installation

```bash
# Check plugin files exist
ls -la ~/.claude/plugins/discode/

# Should show:
# hooks.json
# approval-handler.js
# session-handler.js
# README.md
```

### Environment Variables (Optional)

Set these to customize plugin behavior:

```bash
# Default: http://localhost:3000
export DISCODE_RUNNER_URL="http://localhost:3000"
```

## Testing the Plugin

### Step 1: Start the Test Runner Server

The test server mimics what the real Runner Agent will do:

```bash
# Terminal 1: Start server in auto-approve mode
bun /Users/ray/Documents/DisCode/poc/test-runner-server.ts --auto-approve

# Or start in interactive mode (will prompt for each approval)
bun /Users/ray/Documents/DisCode/poc/test-runner-server.ts
```

You should see:
```
╔════════════════════════════════════════════════════════════╗
║           DisCode Test Runner Server v0.1.0               ║
╠════════════════════════════════════════════════════════════╣
║  🚀 Server running on http://localhost:3000                ║
╚════════════════════════════════════════════════════════════╝
```

### Step 2: Test Claude Code with Plugin

**Terminal 2:** Start Claude Code with a simple task that requires tool use:

```bash
cd /Users/ray/Documents/DisCode/poc
claude --print
```

Then send a prompt that will trigger tool use:

```
Read the package.json file and tell me the version
```

### What Should Happen

1. **Claude Code** attempts to use the `Read` tool
2. **PreToolUse hook** fires automatically
3. **approval-handler.js** sends request to test server
4. **Test Server** receives request and shows:
   ```
   🔔 APPROVAL REQUEST RECEIVED
   📍 Session: abc123...
   🔧 Tool: Read
   ⏰ Time: 2025-01-15T...
   ```

5. **Test Server** responds with allow/deny decision
6. **approval-handler.js** returns decision to Claude Code
7. **Claude Code** continues (or stops if denied)

### Step 3: View Status

Check what requests have been received:

```bash
curl http://localhost:3000/status
```

## Plugin Structure

```
~/.claude/plugins/discode/
├── hooks.json              # Plugin configuration and hook definitions
├── approval-handler.js     # PreToolUse hook handler
├── session-handler.js      # SessionStart/SessionEnd hook handler
└── README.md              # This file
```

## Hook Configuration

The plugin defines three hooks in `hooks.json`:

### 1. PreToolUse Hook
```json
{
  "matcher": "*",  // All tools
  "hooks": [{
    "type": "command",
    "command": "bun ~/.claude/plugins/discode/approval-handler.js"
  }]
}
```

### 2. SessionStart Hook
```json
{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "bun ~/.claude/plugins/discode/session-handler.js start"
  }]
}
```

### 3. SessionEnd Hook
```json
{
  "matcher": "*",
  "hooks": [{
    "type": "command",
    "command": "bun ~/.claude/plugins/discode/session-handler.js end"
  }]
}
```

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User sends prompt to Claude Code                              │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. Claude Code decides to use a tool (Read, Write, Bash, etc.)   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. PreToolUse Hook fires                                         │
│    - Claude Code provides JSON input via stdin                  │
│    - Contains: tool_name, tool_input, session_id                │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. approval-handler.js processes the hook                       │
│    - Parses JSON from stdin                                     │
│    - Sends HTTP POST to localhost:3000/approval                │
│    - Waits for response (30s timeout)                           │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. Runner Agent (Test Server) receives request                  │
│    - Shows tool name and input to user                          │
│    - User approves or denies                                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. Runner Agent responds:                                       │
│    { "allow": true, "message": "Approved by user" }            │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. approval-handler.js outputs decision to stdout               │
│    Claude Code reads and executes or denies the tool            │
└─────────────────────────────────────────────────────────────────┘
```

## Hook Input Format

Claude Code provides this JSON structure to the hook via stdin:

```json
{
  "tool_name": "Read",
  "tool_input": {
    "file_path": "/path/to/file.txt"
  },
  "session_id": "session_abc123",
  "transcript_path": "/path/to/transcript.json"
}
```

## Hook Output Format

The hook must respond with this JSON structure via stdout:

```json
{
  "permissionDecision": "allow",  // or "deny"
  "systemMessage": "Optional message to show to user",
  "modifiedToolInput": {}  // Optional: modify the tool input
}
```

## Troubleshooting

### Plugin not triggering?

1. Verify plugin is installed:
   ```bash
   ls -la ~/.claude/plugins/discode/
   ```

2. Check Claude Code recognizes the plugin:
   ```bash
   claude --help
   # Look for plugin-related output
   ```

### "Cannot reach runner agent" error?

1. Verify test server is running:
   ```bash
   curl http://localhost:3000/
   ```

2. Check if port is already in use:
   ```bash
   lsof -i :3000
   ```

3. Try setting custom URL:
   ```bash
   export DISCODE_RUNNER_URL="http://localhost:3001"
   ```

### Hook times out?

The approval handler has a 30-second timeout. If the Runner Agent doesn't respond within 30 seconds, the tool use will be denied for safety.

### Bun not found?

Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

## Security Considerations

⚠️ **Important Security Notes:**

1. **Plugin executes commands**: This plugin runs commands on your machine via hooks
2. **HTTP communication**: Plugin communicates over HTTP with Runner Agent
3. **Safe default**: If Runner Agent is unreachable, tool use is DENIED
4. **Local only**: Currently only works with localhost Runner Agent

For production:
- Use HTTPS for Runner Agent communication
- Add authentication between plugin and Runner Agent
- Consider sandboxing the plugin execution

## Next Steps

After testing this plugin:

1. ✅ Verify PreToolUse hook works correctly
2. ✅ Test SessionStart/SessionEnd hooks
3. ✅ Build real Discord bot integration
4. ✅ Build real Runner Agent
5. ✅ Replace test server with production system

## Related Files

- **Test Server**: `/Users/ray/Documents/DisCode/poc/test-runner-server.ts`
- **POC Findings**: `/Users/ray/Documents/DisCode/poc/findings.md`
- **Main Plan**: `/Users/ray/Documents/DisCode/plan.md`

## Support

For issues or questions:
- Check the main plan document
- Review POC findings
- Examine test server logs for detailed information
