# Thinking Capture - Quick Reference

## Where to Find Thinking Data

### Source 1: Stream Events (Real-Time)
**Message:** `type: "stream_event"`
**Event:** `event.type: "content_block_delta"`
**Delta:** `event.delta.type: "thinking_delta"`
**Data:** `event.delta.thinking`

```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "thinking_delta",
      "thinking": "Let me analyze..."
    }
  }
}
```

**Usage:** Emit as `outputType: 'thinking'` with `isComplete: false`

### Source 2: Assistant Message (Final)
**Message:** `type: "assistant"`
**Content:** `message.content[].type: "thinking"`
**Data:** `message.content[].thinking`

```json
{
  "type": "assistant",
  "message": {
    "content": [
      {
        "type": "thinking",
        "thinking": "Complete thinking text...",
        "signature": "abc..."
      }
    ]
  }
}
```

**Usage:** Emit as `outputType: 'thinking'` with `isComplete: true`

## Content Block Types

```typescript
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, any> }
  | { type: 'thinking'; thinking: string; signature?: string };
```

## CLI Arguments

```bash
claude \
  --output-format stream-json \
  --input-format stream-json \
  --include-partial-messages \
  --max-thinking-tokens 20000 \
  --permission-prompt-tool stdio
```

## Event Sequence

1. `message_start` - New message begins
2. `content_block_start` (type: "thinking") - Thinking block starts
3. `content_block_delta` (type: "thinking_delta") - Thinking fragments stream in
4. `content_block_stop` - Thinking block complete
5. `message_delta` - Usage metadata
6. `message_stop` - Message complete
7. `assistant` message - Complete message arrives with full thinking block
