# Thinking Blocks - How to Enable

## TL;DR

**Thinking blocks are now enabled by default!** The plugin passes `--max-thinking-tokens 31999` by default, which enables extended thinking.

## How It Works

The plugin now includes the `--max-thinking-tokens` flag when spawning the CLI, matching the VS Code extension behavior:

```typescript
// In claude-sdk-plugin.ts line 505-509
const maxTokens = this.getMaxThinkingTokens();
if (maxTokens > 0) {
    args.push('--max-thinking-tokens', maxTokens.toString());
}
```

**Default value:** 31999 tokens (matches VS Code extension)

## Configuration

You can configure thinking via `PluginOptions`:

```typescript
const options: PluginOptions = {
    // Option 1: Explicit token count
    maxThinkingTokens: 31999,

    // Option 2: Use thinking level (recommended)
    thinkingLevel: 'default_on',  // or 'off', 'low', 'medium', 'high', 'auto'
};
```

### Thinking Levels

| Level | Tokens | Description |
|-------|--------|-------------|
| `off` | 0 | Thinking disabled |
| `low` | 31999 | Minimal thinking |
| `medium` | 31999 | Balanced thinking |
| `high` | 31999 | Maximum thinking |
| `auto` | 31999 | Model decides |
| `default_on` | 31999 | **Default** - thinking enabled |

**Note:** The VS Code extension uses 31999 for all non-off levels.

## What You'll See

When thinking is enabled:

1. **Status updates:** "Status: Thinking" in the embed footer
2. **Purple embeds** titled "Thinking" with the thought process
3. **Real-time streaming** of thinking content (no batching)
4. **Final response** after thinking completes

## Debugging

Check if thinking is enabled in the logs:

```bash
# Look for this message when session starts
grep "Extended thinking enabled" /tmp/claude-sdk-debug/*.jsonl
```

Expected output:
```json
{
  "timestamp": "...",
  "sessionId": "...",
  "message": "Extended thinking enabled: 31999 tokens"
}
```

## Model Support

| Model | Supports Thinking | Notes |
|-------|------------------|-------|
| Claude Sonnet 4.5 | ✅ Yes | Full extended thinking |
| Claude Haiku 4.5 | ⚠️ Limited | May not emit thinking blocks |
| Gemini (glm-* ) | ⚠️ Varies | May use different mechanism |
| Other models | ⚠️ Varies | Depends on model support |

**Important:** Even if a model supports thinking internally, it must emit `thinking_delta` events in the stream-json protocol for the plugin to capture them.

## How Thinking Is Captured

The plugin captures thinking from **two sources**:

1. **Stream events** (real-time):
   ```json
   {
     "type": "stream_event",
     "event": {
       "type": "content_block_delta",
       "delta": {
         "type": "thinking_delta",
         "thinking": "Let me analyze..."
       }
     }
   }
   ```

2. **Complete assistant message** (final):
   ```json
   {
     "type": "assistant",
     "message": {
       "content": [
         {
           "type": "thinking",
           "thinking": "Complete thought process...",
           "signature": "abc..."
         }
       ]
     }
   }
   ```

See [claude-code-extension-protocol.md](claude-code-extension-protocol.md) for full protocol details.

## Why You Weren't Seeing Thinking Before

The plugin was missing the `--max-thinking-tokens` CLI argument. This flag tells the CLI to:

1. Enable extended thinking in the model
2. Stream `thinking_delta` events
3. Include `thinking` content blocks in assistant messages

**This has been fixed!** Thinking is now enabled by default.
