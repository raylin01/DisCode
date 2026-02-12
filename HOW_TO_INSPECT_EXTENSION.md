# How to Inspect Claude Code Extension Communication

This document shows various ways to see what the VS Code extension sends/receives from the SDK.

## Method 1: Live Debug Logs (Recommended)

The Claude Code extension writes debug logs to:
```
~/.claude/debug/
```

### Monitor in real-time:
```bash
# Follow the latest log
tail -f ~/.claude/debug/latest

# Filter for permission requests
tail -f ~/.claude/debug/latest | grep -A 10 "control_request"

# Filter for permission responses
tail -f ~/.claude/debug/latest | grep -A 10 "control_response"
```

### Or use the provided monitor script:
```bash
/tmp/claude-debug-monitor.sh
```

## Method 2: Runner-Agent Logs (Now Enhanced)

The runner-agent now logs **both** incoming permission requests AND outgoing responses:

### To see permission requests from SDK:
```bash
# Look for "Permission suggestions:" in runner-agent logs
# This shows the exact structure of suggestions sent by SDK
```

### To see what we send back to SDK:
```bash
# Look for "Sending control response:" in runner-agent logs
# This shows the exact response structure (behavior, updatedInput, updatedPermissions)
```

### Example output:
```json
// Incoming request (from SDK)
Permission suggestions: [
  {
    "type": "addRules",
    "rules": [{"toolName": "Bash", "ruleContent": "command:*"}]
  },
  {
    "type": "addDirectories",
    "directories": ["/path/to/dir"]
  }
]

// Outgoing response (to SDK)
Sending control response: {
  "behavior": "allow",
  "toolUseID": "tool_123",
  "updatedInput": {
    "command": "ls -la"
  },
  "updatedPermissions": [
    {
      "type": "addRules",
      "destination": "localSettings",
      "rules": [...]
    }
  ]
}
```

## Method 3: Check Past Sessions

Claude Code stores session history:
```
~/.claude/history.jsonl          # Main history
~/.claude/session-env/           # Session environments
~/.claude/projects/              # Project-specific data
~/.claude/debug/<uuid>.txt       # Individual session logs
```

### To find a specific session:
```bash
# List all debug logs by date
ls -lt ~/.claude/debug/*.txt | head -20

# Search for permission-related activity in a log
grep "permission\|control_" ~/.claude/debug/<uuid>.txt
```

## Method 4: Enable Verbose SDK Logging

You can enable more verbose logging in Claude Code settings:

```json
// ~/.claude/settings.json
{
  "env": {
    "DEBUG": "claude-sdk:*",  // Enable SDK debug logs
    "NODE_ENV": "development"
  }
}
```

## Method 5: VS Code Developer Tools

1. Open VS Code
2. Help → Toggle Developer Tools
3. Go to "Console" tab
4. Filter for extension messages:
   - `control_request` - incoming permission requests
   - `control_response` - outgoing permission responses
   - `can_use_tool` - tool permission requests
   - `permission_suggestions` - suggestions for "Always" button

## Expected Data Structure

### Incoming Permission Request:
```json
{
  "type": "control_request",
  "request_id": "uuid",
  "request": {
    "subtype": "can_use_tool",
    "tool_name": "Bash",
    "input": {"command": "ls"},
    "permission_suggestions": [
      {
        "type": "addRules",
        "rules": [...]
      }
    ],
    "tool_use_id": "tool_123",
    "agent_id": "agent_456"
  }
}
```

### Outgoing Permission Response:
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success",
    "request_id": "uuid",
    "response": {
      "behavior": "allow",  // or "deny"
      "toolUseID": "tool_123",
      "updatedInput": {...},  // Optional: modified input
      "updatedPermissions": [  // Optional: for "Always" button
        {
          "type": "addRules",
          "destination": "localSettings",  // IMPORTANT!
          "rules": [...]
        }
      ],
      "message": "..."  // Optional: for deny with reason
    }
  }
}
```

## Key Things to Verify:

1. ✅ **`updatedInput` is ALWAYS included** (SDK requirement)
2. ✅ **`destination` field is added to ALL suggestions** (not just setMode)
3. ✅ **`behavior` is only "allow" or "deny"** (no "delegate")
4. ✅ **`toolUseID` matches the request**
5. ✅ **`request_id` matches the request**

## Debugging Common Issues:

### Issue: "updatedInput is required but received undefined"
**Fix**: Always include `updatedInput` in the response, even if unchanged:
```typescript
updatedInput: updatedInput || pendingData.input
```

### Issue: "Invalid literal value, expected 'allow'"
**Fix**: Only use `"allow"` or `"deny"` for behavior, never `"delegate"`

### Issue: Permission suggestions not being saved
**Fix**: Make sure EVERY suggestion has a `destination` field:
```typescript
{
  type: "addRules",
  destination: scope,  // MUST be present!
  rules: [...]
}
```

## Current Implementation Status:

✅ Fixed: `delegate` behavior removed (now using `deny`)
✅ Fixed: `destination` field added to all suggestions
✅ Fixed: `updatedInput` always included in responses
✅ Fixed: Permission requests stored in both old and new systems
✅ Added: Detailed logging for debugging
✅ Added: Tool input shown in approval confirmations

## Next Steps:

1. Test the permission flow with actual tool use
2. Verify the logs show correct structure
3. Compare with VS Code extension behavior
4. Ensure permissions are properly saved to `.claude/settings.json`
