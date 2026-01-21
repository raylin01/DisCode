# DisCode - Multi-CLI & Port Update Summary

**Date:** 2025-01-16
**Version:** 0.4.0 (Development)

---

## 🎉 What's New

### 1. Multi-CLI Support Per Runner
Runners can now support **multiple CLI types simultaneously**!

**Before:**
- Each runner supported only ONE CLI type (claude OR gemini)
- Had to run separate runners for each CLI

**After:**
- Each runner can support **both claude AND gemini**
- Configured via `DISCORDE_CLI_TYPES` environment variable
- Example: `DISCORDE_CLI_TYPES=claude,gemini`

### 2. Default Port Changed
Changed from port 3000 to **3122** to avoid conflicts with Next.js.

**Why:** Next.js uses port 3000 by default, causing conflicts for users who develop with both.

---

## 📝 Configuration Changes

### Runner Agent `.env`

```bash
# OLD (v0.3.0)
DISCORDE_CLI_TYPE=claude
DISCORDE_HTTP_PORT=3000

# NEW (v0.4.0)
DISCORDE_CLI_TYPES=claude          # Single CLI
# OR
DISCORDE_CLI_TYPES=claude,gemini   # Multiple CLIs
DISCORDE_HTTP_PORT=3122            # New default port
```

### Environment Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `DISCORDE_CLI_TYPES` | List | `claude` | Comma-separated CLI types (claude, gemini) |
| `DISCORDE_HTTP_PORT` | Number | `3122` | HTTP server port for CLI plugins |

---

## 🔧 Technical Changes

### Shared Types (`shared/types.ts`)

**RunnerInfo:**
```typescript
// OLD
cliType: 'claude' | 'gemini';

// NEW
cliTypes: ('claude' | 'gemini')[];
```

**Session:**
```typescript
// Added field
cliType: 'claude' | 'gemini';  // Which CLI this session uses
```

**WebSocket Messages:**
```typescript
// Added 'register' message type
type: 'approval_request' | 'approval_response' | 'heartbeat' | 'register' | ...

// Added RegisterMessage
interface RegisterMessage {
  type: 'register';
  data: {
    runnerId: string;
    runnerName: string;
    token: string;
    cliTypes: ('claude' | 'gemini')[];
  };
}
```

### Runner Agent (`runner-agent/src/index.ts`)

**Changes:**
1. Accepts `DISCORDE_CLI_TYPES` (comma-separated)
2. Sends 'register' message on connection (includes token)
3. Reports all supported CLI types in heartbeat
4. Updated startup banner to show all CLI types

**Example Output:**
```
╔════════════════════════════════════════════════════════════╗
║           DisCode Runner Agent v0.1.0                     ║
╠════════════════════════════════════════════════════════════╣
║  Runner ID: runner_my_macbook_pro_123                     ║
║  Runner Name: my-macbook-pro                              ║
║  CLI Types: claude, gemini                                ║  ← Multiple CLIs!
║  HTTP Server: http://localhost:3122                       ║  ← New port!
║  Bot WebSocket: ws://localhost:8080                        ║
╚════════════════════════════════════════════════════════════╝
```

### Discord Bot (`discord-bot/src/index.ts`)

**Changes:**
1. Handles 'register' messages (validates token, creates/updates runners)
2. Stores CLI types array per runner
3. Updated commands to display multiple CLI types
4. Sessions now record which CLI type is being used

**Commands Updated:**
- `/list-runners` - Shows all CLI types
- `/runner-status` - Shows all CLI types
- `/create-session` - Selects CLI type for session

**Example Outputs:**

```
🖥️ Your Runners
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🟢 my-macbook-pro
ID: runner_abc123
CLI: CLAUDE, GEMINI    ← Multiple CLIs
Status: online
```

```
📊 my-macbook-pro Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Status:        🟢 Online
CLI Types:     CLAUDE, GEMINI    ← Multiple CLIs
Active Sessions: 2
```

```
🚀 Session Started
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Runner: my-macbook-pro
CLI: GEMINI              ← Session uses specific CLI
Session ID: session_123
```

### CLI Plugins

**All plugins updated to use new default port (3122):**

- `~/.claude/plugins/discode/approval-handler.js`
- `~/.claude/plugins/discode/session-handler.js`
- `~/.gemini/discode/before-tool-handler.sh`
- `~/.gemini/discode/session-handler.sh`

**Default URL changed from:**
```javascript
const RUNNER_AGENT_URL = 'http://localhost:3000';  // OLD
```

**To:**
```javascript
const RUNNER_AGENT_URL = 'http://localhost:3122';  // NEW
```

---

## 📦 New Files

### Plugin Installation System

```
DisCode/
├── plugins/
│   ├── README.md                    # Plugin documentation
│   ├── claude/                      # Claude Code plugin files
│   │   ├── hooks.json
│   │   ├── approval-handler.js
│   │   ├── session-handler.js
│   │   └── README.md
│   └── gemini/                      # Gemini CLI plugin files
│       ├── before-tool-handler.sh
│       ├── session-handler.sh
│       └── README.md
└── install-plugins.sh               # Installation script
```

**Installation:**
```bash
./install-plugins.sh
```

---

## 🔄 Migration Guide

### For Existing Users

**1. Update Runner Agent `.env`:**
```bash
cd runner-agent

# Edit .env file
nano .env

# Change:
DISCORDE_CLI_TYPE=claude
# To:
DISCORDE_CLI_TYPES=claude,gemini

# Change:
DISCORDE_HTTP_PORT=3000
# To:
DISCORDE_HTTP_PORT=3122
```

**2. Reinstall Plugins (for new port):**
```bash
cd DisCode
./install-plugins.sh
```

**3. Restart Services:**
```bash
# Stop existing services
# Then restart:
cd discord-bot && bun run src/index.ts
cd runner-agent && bun run src/index.ts
```

### For New Users

Just follow the updated README.md - defaults are already set to the new values!

---

## 🎯 Usage Examples

### Setup Multi-CLI Runner

```bash
# In runner-agent/.env
DISCORDE_CLI_TYPES=claude,gemini
DISCORDE_HTTP_PORT=3122

# Start runner agent
bun run src/index.ts

# Output shows:
# CLI Types: claude, gemini
```

### Create Session with Specific CLI

```bash
# In Discord
/create-session runner_abc gemini

# Bot creates session configured for Gemini CLI
```

### View Runner Status

```bash
/runner-status runner_abc

# Shows:
# CLI Types: CLAUDE, GEMINI
```

---

## ✅ Testing Checklist

- [ ] Runner agent starts with new port 3122
- [ ] Runner agent registers with multiple CLI types
- [ ] `/list-runners` shows multiple CLI types
- [ ] `/runner-status` shows multiple CLI types
- [ ] `/create-session` can select specific CLI
- [ ] Plugins connect to port 3122
- [ ] Approvals work for both Claude and Gemini
- [ ] Sessions record correct CLI type

---

## 🐛 Bug Fixes

1. **Deprecation Warning Fixed:** Changed `'ready'` → `'clientReady'` event
2. **Port 8080 Error Fixed:** Added proper error handling for WebSocket server
3. **Port 3000 Conflict Fixed:** Changed default to 3122

---

## 📊 Statistics

**Files Modified:**
- `shared/types.ts` - Updated RunnerInfo, Session, added RegisterMessage
- `runner-agent/src/index.ts` - Multi-CLI support, registration flow
- `runner-agent/.env.example` - Updated with CLI_TYPES and new port
- `discord-bot/src/index.ts` - Register handling, multi-CLI display
- `discord-bot/src/storage.ts` - Already supports cliTypes array
- All CLI plugins - Updated default port to 3122

**Files Added:**
- `plugins/` directory structure
- `install-plugins.sh` - Installation script
- `plugins/README.md` - Plugin documentation
- `CHANGELOG.md` - This file

**Total Changes:**
- ~100 lines added/modified across 10+ files
- 5 new files created
- Breaking changes: Port change (3000→3122), CLI_TYPE→CLI_TYPES

---

## 🚀 Next Steps

1. ✅ Multi-CLI support - COMPLETE
2. ⏳ Interactive session creation with button flow - TODO
3. ⏳ Folder path selection for sessions - TODO
4. ⏳ Testing with real CLI sessions - TODO

---

## 💡 Future Enhancements

Based on your feedback, here are planned features:

### Interactive Session Creation

**Flow:**
1. User: `/create-session`
2. Bot: Shows list of runners as buttons
3. User: Clicks a runner
4. Bot: Shows available CLI types as buttons (based on runner's CLI_TYPES)
5. User: Clicks a CLI type
6. Bot: Asks for folder path (with default)
7. Bot: Creates session in private thread

### Folder Path Selection

**Implementation:**
- Add modal or text input for folder path
- Store in session metadata
- Pass to CLI when starting session

---

**Generated:** 2025-01-16
**Version:** 0.4.0-dev
**Status:** ✅ Multi-CLI Complete, Ready for Testing
