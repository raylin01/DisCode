# DisCode Quick Reference Guide

## All Commands

### Token & Authentication
```
/generate-token
```
Generate a token to connect your Runner Agent.

### Runner Management
```
/list-runners
```
List all runners you own.

```
/my-access
```
Show all runners you can access (owned + shared with you).

```
/runner-status <runner_id>
```
Show detailed status of a specific runner.

### Sessions
```
/create-session [runner_id] [cli_type]
```
Create a new CLI session in a private thread.
- `runner_id` (optional): Which runner to use
- `cli_type` (optional): `claude` or `gemini`

### Sharing & Permissions
```
/share-runner @user <runner_id>
```
Share one of your runners with another user.

```
/list-access [runner_id]
```
Show users who have access to your runners.
- No args: Overview of all your runners
- With runner_id: Detailed user list for that runner

```
/unshare-runner @user <runner_id>
```
Revoke a user's access to your runner.

### Action Items
```
/action-items [session_id]
```
Show action items extracted from CLI output.
- No args: Show all action items across sessions
- With session_id: Show items for specific session

---

## Embed Colors & Meanings

| Color | Meaning | Usage |
|-------|---------|-------|
| 🟢 Green | Success | Token generated, runner online, allowed |
| 🔴 Red | Error/Danger | Access denied, runner offline, denied |
| 🔵 Blue | Info | User commands, information |
| 🟡 Gold | Warning/Pending | Approval required, action items |
| 🟠 Orange | Warning | Stderr output |

---

## Icon Legend

| Icon | Meaning |
|------|---------|
| 🟢 | Online/Active |
| 🔴 | Offline/Inactive |
| 👑 | Owned by you |
| 🔓 | Shared with you |
| 📤 | Output (stdout) |
| 🔧 | Tool Use |
| ✅ | Success/Allowed |
| ❌ | Error/Denied |
| ⚠️ | Warning |
| 📝 | Action Item |
| 🚀 | Session Start |
| 🔔 | Approval Required |
| 📊 | Status |
| 👥 | Users/Access |
| 🔑 | Access |

---

## Quick Workflows

### Setup New Runner
1. `/generate-token` - Copy token
2. Start Runner Agent with token
3. `/list-runners` - Verify it appears

### Share with Colleague
1. `/list-runners` - Get your runner ID
2. `/share-runner @colleague runner_id`
3. Colleague runs `/my-access` to verify

### Check Runner Health
1. `/runner-status runner_id` - See detailed status
2. Look for:
   - 🟢 Online / 🔴 Offline
   - Active Sessions count
   - Last Heartbeat time

### Create CLI Session
1. `/create-session` - Uses first online runner
2. Or: `/create-session runner_id claude` - Specific runner
3. Bot creates private thread
4. Type your prompt in the thread

### View Tasks
1. `/action-items` - See all extracted tasks
2. Look for:
   - TODO items
   - [ ] checkboxes
   - FIXME notes
   - ACTION items

---

## Permission Levels

**Owner:**
- Can use all commands
- Can share/unshare runners
- Gets notified when runner goes offline

**Authorized User:**
- Can create sessions on shared runners
- Can approve/deny tool use
- Can view runner status
- Cannot share/unshare (owner only)

---

## Runner Status Reference

**Status Values:**
- `online` - Runner connected and working
- `offline` - Runner disconnected

**CLI Types:**
- `claude` - Claude Code
- `gemini` - Gemini CLI

**Session Counts:**
- Active sessions are currently running
- Ended sessions are in history

---

## Troubleshooting

### Runner shows as offline
1. Check Runner Agent is running
2. Check token is correct
3. Check network connection
4. You'll get a DM notification when it goes offline

### Can't access shared runner
1. Ask owner to share with you using `/share-runner`
2. Verify they used your correct @mention
3. Check `/my-access` to see if it appears

### Action items not appearing
1. Make sure CLI output contains TODO/ACTION/FIXME patterns
2. Use `/action-items` to view
3. Action items are session-specific

### Commands not working
1. Check you have permission (own runner or have access)
2. Verify runner ID is correct
3. Use `/my-access` or `/list-runners` to verify

---

## Tips & Tricks

**Quick Status Check:**
```
/list-runners          # Your runners only
/my-access             # All accessible runners
/runner-status <id>    # Detailed status
```

**Permission Management:**
```
/share-runner @user <id>     # Grant access
/list-access <id>           # Check who has access
/unshare-runner @user <id>   # Revoke access
```

**Session Management:**
```
/create-session                 # First available runner
/create-session <id>           # Specific runner
/create-session <id> gemini    # Specific runner + CLI type
/action-items                   # See all tasks
/action-items <session_id>     # See session tasks
```

---

## Keyboard Shortcuts (Discord)

- **Tab** - Autocomplete command names
- **@mention** - Autocomplete usernames
- **Escape** - Close popup (doesn't send)
- **Enter** - Send command

---

## Command Options Reference

### `/create-session` Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| runner | String | ❌ | Runner ID (uses first online if empty) |
| cli | Enum | ❌ | `claude` or `gemini` (auto-detect if empty) |

### `/list-access` Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| runner | String | ❌ | Runner ID (shows overview if empty) |

### `/action-items` Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| session | String | ❌ | Session ID (shows all if empty) |

### `/runner-status` Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| runner | String | ✅ | Runner ID to check |

### `/share-runner` & `/unshare-runner` Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| user | User | ✅ | User to grant/revoke access |
| runner | String | ✅ | Runner ID |

---

## Data Persistence

All data is stored in YAML files:

**Location:** `./data/` (or `DISCORD_TOKEN_STORAGE_PATH`)

**Files:**
- `users.yaml` - User tokens and runner ownership
- `runners.yaml` - Runner registration and status
- `sessions.yaml` - Session history

**Backup:** Copy the `./data/` folder regularly!

---

## Support

For issues:
1. Check this guide first
2. Check `/plan.md` for architecture
3. Check `README.md` for setup instructions
4. Check logs in Discord bot console

---

**Last Updated:** 2025-01-15
**Version:** 0.2.0 (Phase 2 & 3 Complete)
