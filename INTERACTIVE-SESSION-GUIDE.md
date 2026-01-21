# Interactive Session Creation Guide

**Feature Added:** v0.4.0

The `/create-session` command now uses an **interactive button-based flow** for easy session creation!

---

## 🎯 How It Works

### Step 1: Select Runner
```
/create-session
```

Shows you a list of your online runners as buttons:
```
🚀 Create New Session
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Select a runner to use for this session:

Available Runners: 2 online

[🟢 my-macbook-pro (CLAUDE, GEMINI)] [🟢 gaming-pc (CLAUDE)]
[❌ Cancel]

Step 1 of 3: Select Runner
```

### Step 2: Select CLI Type
After clicking a runner, you'll see available CLI types:
```
🔧 Select CLI Type
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Runner `my-macbook-pro` supports the following CLI types:

Selected Runner: my-macbook-pro
Available CLI Types: CLAUDE, GEMINI

[🤖 CLAUDE] [✨ GEMINI]
[← Back to Runners] [❌ Cancel]

Step 2 of 3: Select CLI Type
```

### Step 3: Confirm Folder
Finally, confirm the session settings:
```
📁 Select Working Folder
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Almost ready! The session will use:

Runner: `my-macbook-pro`
CLI: GEMINI

Folder path: You can set a default working directory in the Runner Agent's environment, or specify it per session.

Current Selection:
Runner: my-macbook-pro
CLI: GEMINI

Default Folder: Runner agent default (configured in .env)

[✅ Use Default Folder] [← Go Back]

Step 3 of 3: Configure Session
```

### Session Created!
```
✅ Session Created Successfully!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Your session has been created in [private thread]

Runner: my-macbook-pro
CLI Type: GEMINI
Thread: [Click to open]
```

---

## 🎨 Features

### Smart Runner Display
- Shows runner name with supported CLI types
- Online/offline status with emoji indicators (🟢/🔴)
- Only shows runners you have access to

### Multi-CLI Support
- Each runner shows which CLI types it supports
- Buttons dynamically show available options
- Automatically filters based on runner capabilities

### Easy Navigation
- **Back buttons** to go to previous step
- **Cancel button** to abort at any time
- State tracked per-user (multiple users can create sessions simultaneously)

### Clear Progress Indication
- Step counter (Step 1 of 3, Step 2 of 3, etc.)
- Color-coded steps (Blue → Gold → Green)
- Summary of selections at each step

---

## 🔧 Technical Details

### State Management
The bot tracks each user's progress through the flow:

```typescript
sessionCreationState: Map<userId, {
  step: 'select_runner' | 'select_cli' | 'select_folder' | 'complete';
  runnerId?: string;
  cliType?: 'claude' | 'gemini';
  folderPath?: string;
  messageId?: string;
}>
```

### Button IDs
Buttons use custom IDs for routing:
- `session_runner_{runnerId}` - Runner selection
- `session_cli_{cliType}` - CLI type selection
- `session_skip_folder` - Use default folder
- `session_cancel` - Cancel creation

### Error Handling
- Invalid/expired state shows error with restart prompt
- Access denied for unauthorized runners
- Graceful handling of missing runners or CLI types

---

## 📝 Configuration

### Default Working Directory

To set a default working directory for sessions, configure it in your Runner Agent:

**Option 1: Environment Variable (Future)**
```bash
# In runner-agent/.env
DISCODE_DEFAULT_WORKSPACE=/Users/yourname/projects
```

**Option 2: Per-Session (Current)**
Currently, sessions use the directory where the CLI is run. Future versions will support folder selection.

---

## 🚀 Usage Examples

### Example 1: Single Runner, Single CLI
```
User: /create-session
Bot: Shows 1 runner button
User: Clicks "my-macbook-pro (CLAUDE)"
Bot: Shows CLAUDE button (only option)
User: Clicks "CLAUDE"
Bot: Shows confirmation
User: Clicks "Use Default Folder"
Bot: Creates session ✅
```

### Example 2: Multi-CLI Runner
```
User: /create-session
Bot: Shows runners
User: Clicks "workstation (CLAUDE, GEMINI)"
Bot: Shows both CLI options
User: Clicks "GEMINI"
Bot: Shows confirmation
User: Clicks "Use Default Folder"
Bot: Creates session ✅
```

### Example 3: Cancel and Restart
```
User: /create-session
Bot: Shows runners
User: Clicks "Cancel"
Bot: ❌ Session Creation Cancelled
User: /create-session
Bot: Shows runners (fresh start)
```

---

## 🎯 Best Practices

### 1. Use Descriptive Runner Names
```bash
# Good
DISCODE_RUNNER_NAME=production-macbook
DISCODE_RUNNER_NAME=testing-pc

# Avoid
DISCODE_RUNNER_NAME=runner1
DISCODE_RUNNER_NAME=abc
```

### 2. Configure CLI Types Upfront
```bash
# Set all CLI types you'll use
DISCODE_CLI_TYPES=claude,gemini
```

### 3. Check Runner Status First
```
/list-runners          # See what's online
/runner-status <id>    # Check details
/create-session        # Then create session
```

---

## 🐛 Troubleshooting

### Buttons Not Working
**Problem:** Clicking buttons does nothing

**Solutions:**
- Check bot has permission in the channel
- Try running `/create-session` again
- Check bot console for errors

### "Session Expired" Error
**Problem:** State lost during flow

**Solution:**
- Start over with `/create-session`
- Don't wait too long between steps (5 min timeout)

### No Runners Showing
**Problem:** "No online runners available"

**Solutions:**
- Start your Runner Agent: `cd runner-agent && bun run src/index.ts`
- Check token is valid
- Use `/list-runners` to verify runner status

### Wrong CLI Types Showing
**Problem:** Runner shows wrong CLI types

**Solutions:**
- Restart Runner Agent with correct `DISCODE_CLI_TYPES`
- Wait 30 seconds for heartbeat
- Runner will auto-update in Discord bot

---

## 🔄 Future Enhancements

Planned improvements:
- ✅ Folder path selection modal
- ✅ Session templates (pre-configured settings)
- ✅ Quick-create with last used settings
- ✅ Session favorites/presets

---

## 💡 Tips

**Quick Session:**
- If you have only one runner, you'll skip step 1
- If runner has only one CLI, you'll skip step 2
- Fast path: → Select Runner → Confirm → Done!

**Multiple Users:**
- Each user has independent state
- Multiple users can create sessions simultaneously
- No interference between users

**Cancel Anywhere:**
- Click "Cancel" or "← Go Back" at any step
- State is cleaned up automatically
- Can start over immediately

---

**Version:** 0.4.0
**Last Updated:** 2025-01-16
**Status:** ✅ Fully Implemented & Ready to Use
