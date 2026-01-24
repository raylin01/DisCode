# Thinking Blocks - Requirements and Limitations

## Issue: Thinking Blocks Not Showing

### Root Cause

Your debug log shows that you're using the **Gemini model (glm-4.7)**:

```
"model":"glm-4.7"
"hasThinkingMetadata":false
```

**Thinking blocks are a Claude-specific feature.** They are only available when using Claude models with extended thinking enabled.

### What Are Thinking Blocks?

Thinking blocks are a feature where Claude models output their internal reasoning process before the final response. This is:

1. **Streamed in real-time** via `thinking_delta` events
2. **Available in the complete message** via `content_block.type: "thinking"`
3. **Only available for Claude models** with sufficient `maxThinkingTokens` set

### Models That Support Thinking

| Model | Supports Thinking | Notes |
|-------|------------------|-------|
| `claude-sonnet-4-5-20250929` | ✅ Yes | Extended thinking available |
| `claude-haiku-4-5-20251001` | ❌ No | Fast model, no thinking |
| `glm-4.7` (Gemini) | ❌ No | Not supported |
| `gemini-*` | ❌ No | Not supported |

### How to Enable Thinking Blocks

1. **Use a Claude model** that supports thinking:
   ```bash
   --model claude-sonnet-4-5-20250929
   ```

2. **Set max thinking tokens** (default is 20000 for Sonnet):
   ```bash
   --max-thinking-tokens 20000
   ```

3. **Enable thinking level** in your Claude Code settings:
   ```typescript
   // In your extension or plugin
   thinkingLevel: 'high'  // or 'medium', 'low', 'auto'
   ```

### Verification

You can verify if thinking is enabled by checking the assistant message:

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me analyze this code...",
        "signature": "abc..."
      }
    ]
  },
  "thinkingMetadata": {
    "level": "high",
    "disabled": false,
    "triggers": ["code_analysis", "debugging"]
  }
}
```

### Debug Log Analysis

Check your debug log at `/tmp/claude-sdk-debug/*.jsonl`:

```bash
# Check if thinking metadata exists
grep "hasThinkingMetadata" /tmp/claude-sdk-debug/*.jsonl

# Check for thinking deltas
grep "thinking_delta" /tmp/claude-sdk-debug/*.jsonl

# Check the model being used
grep '"model":' /tmp/claude-sdk-debug/*.jsonl | tail -5
```

### Expected Output With Thinking

When using Claude with thinking enabled, you should see:

1. **Status updates** in Discord: "Status: Thinking"
2. **Purple embeds** with title "Thinking" containing the thought process
3. **Final response** after thinking completes

### Alternative for Non-Claude Models

If you need to use Gemini or other models:

1. **Ask for reasoning in the prompt**: "Think through this step by step..."
2. **Use the model's native reasoning** if available (Gemini has different features)
3. **Switch to Claude** when extended thinking is important

### Implementation Notes

Your `claude-sdk-plugin.ts` already correctly handles thinking:

- **Lines 747-758**: Captures `thinking_delta` from stream events
- **Lines 720-729**: Sets "Thinking" status when thinking starts
- **Lines 917-934**: Captures complete thinking blocks from assistant messages

The plugin will emit thinking content as soon as the Claude model provides it.
