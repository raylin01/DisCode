# Claude Code Extension Protocol Analysis

This document describes how the Claude Code VS Code extension communicates with Claude, including how thinking blocks are captured and where the data lives.

## Overview

The Claude Code extension communicates with the Claude CLI using a **bidirectional JSON streaming protocol** over stdin/stdout. The CLI is spawned with specific flags to enable this protocol.

## CLI Spawn Arguments

From line 28888 of extension-beautified.js:

```javascript
J = [
    "--output-format", "stream-json",
    "--verbose",
    "--input-format", "stream-json",
    "--include-partial-messages"
];
```

Additional flags based on configuration:
- `--max-thinking-tokens <N>` - Controls thinking block size
- `--permission-prompt-tool stdio` - Enables interactive permission prompts
- `--model <model>` - Specifies model
- `CLAUDE_CODE_ENTRYPOINT=sdk-ts` - Environment variable

## Protocol Structure

### Communication Flow

```
Extension (stdout) ← → Claude CLI (stdin)
     JSON lines              JSON lines
```

Both sides communicate with newline-delimited JSON messages.

### Message Types (CLI → Extension)

The extension receives these message types from the CLI:

#### 1. System Message (`type: "system"`)
```json
{
  "type": "system",
  "subtype": "init",
  "session_id": "string",
  "cwd": "string",
  "tools": ["string"],
  "mcp_servers": [{"name": "string", "status": "string"}],
  "model": "string",
  "permissionMode": "string",
  "claude_code_version": "string",
  "uuid": "string (optional)"
}
```

#### 2. Stream Event (`type: "stream_event"`)
**This is where real-time thinking deltas come from.**

```json
{
  "type": "stream_event",
  "event": { /* StreamEvent */ },
  "session_id": "string",
  "parent_tool_use_id": "string | null",
  "uuid": "string"
}
```

**StreamEvent types:**

| Event Type | Description |
|-----------|-------------|
| `message_start` | New message starting |
| `content_block_start` | New content block (text, tool_use, or thinking) |
| `content_block_delta` | **Real-time content delta (text, thinking, JSON)** |
| `content_block_stop` | Content block complete |
| `message_delta` | Message metadata update (usage, stop_reason) |
| `message_stop` | Message complete |

**Content Block Start (when thinking begins):**
```json
{
  "type": "content_block_start",
  "index": 0,
  "content_block": {
    "type": "thinking"  // or "text" or "tool_use"
  }
}
```

**Content Block Delta (real-time thinking data):**
```json
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "thinking_delta",  // or "text_delta" or "input_json_delta"
    "thinking": "The actual thinking content here..."
  }
}
```

#### 3. Assistant Message (`type: "assistant"`)
**This contains the complete thinking block in final form.**

```json
{
  "type": "assistant",
  "message": {
    "id": "string",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "Complete thinking block content",
        "signature": "string (optional)"
      }
      // May also include text and tool_use content blocks
    ],
    "stop_reason": "string | null",
    "usage": {
      "input_tokens": 0,
      "output_tokens": 0
    }
  },
  "session_id": "string",
  "uuid": "string",
  "thinkingMetadata": {
    "level": "string",
    "disabled": false,
    "triggers": ["string"]
  },
  "todos": [
    {
      "id": "string",
      "content": "string",
      "status": "pending|in_progress|completed"
    }
  ]
}
```

#### 4. User Message (`type: "user"`)
Contains tool results from previous tool_use:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "tool_result",
        "content": "string",
        "is_error": false,
        "tool_use_id": "string"
      }
    ]
  },
  "session_id": "string",
  "uuid": "string"
}
```

#### 5. Control Request (`type: "control_request"`)
Interactive permission prompts and questions:

```json
{
  "type": "control_request",
  "request_id": "string",
  "request": {
    "subtype": "can_use_tool" | "hook_callback" | "mcp_message",
    "tool_name": "string",
    "input": {},
    "permission_suggestions": ["string"],
    "tool_use_id": "string"
  }
}
```

### Message Types (Extension → CLI)

#### User Input
```json
{
  "type": "user",
  "session_id": "string",
  "message": {
    "role": "user",
    "content": [
      {
        "type": "text",
        "text": "User message here"
      }
    ]
  },
  "parent_tool_use_id": null
}
```

#### Control Response
```json
{
  "type": "control_response",
  "response": {
    "subtype": "success" | "error",
    "request_id": "string",
    "response": {
      "behavior": "allow" | "deny" | "delegate",
      "toolUseID": "string",
      "selectedOptions": ["string"]
    }
  }
}
```

## Where Thinking Data Is Located

### 1. Real-Time Streaming (Live Updates)

**Location:** Stream events with `delta.type: "thinking_delta"`

**How to capture:**
```typescript
if (message.type === 'stream_event') {
    const event = message.event;
    if (event.type === 'content_block_delta') {
        if (event.delta.type === 'thinking_delta') {
            // event.delta.thinking contains the thinking fragment
            emitThinking(event.delta.thinking);
        }
    }
}
```

**Example message:**
```json
{
  "type": "stream_event",
  "event": {
    "type": "content_block_delta",
    "index": 0,
    "delta": {
      "type": "thinking_delta",
      "thinking": "Let me analyze this code..."
    }
  }
}
```

### 2. Complete Thinking Block (Final)

**Location:** Assistant message with `content[].type: "thinking"`

**How to capture:**
```typescript
if (message.type === 'assistant') {
    for (const block of message.message.content) {
        if (block.type === 'thinking') {
            // block.thinking contains the complete thinking block
            emitCompleteThinking(block.thinking);
        }
    }
}
```

**Example message:**
```json
{
  "type": "assistant",
  "message": {
    "id": "msg_123",
    "role": "assistant",
    "content": [
      {
        "type": "thinking",
        "thinking": "Let me analyze this code carefully. The function is doing X, Y, Z...",
        "signature": "abc123..."
      },
      {
        "type": "text",
        "text": "Here's my response..."
      }
    ],
    "stop_reason": "end_turn",
    "usage": {
      "input_tokens": 1000,
      "output_tokens": 500
    }
  }
}
```

### 3. Thinking Metadata

**Location:** Assistant message top-level `thinkingMetadata` field

```json
{
  "type": "assistant",
  "thinkingMetadata": {
    "level": "high",  // or "medium", "low", "auto"
    "disabled": false,
    "triggers": ["code_analysis", "debugging"]
  }
}
```

## Content Block Types

Complete list of content block types that can appear in messages:

| Type | Structure | Purpose |
|------|-----------|---------|
| `text` | `{type: "text", text: string}` | Regular text response |
| `tool_use` | `{type: "tool_use", id: string, name: string, input: {}}` | Tool invocation |
| `thinking` | `{type: "thinking", thinking: string, signature?: string}` | **Thinking block** |

## Max Thinking Tokens

The extension controls thinking size via `--max-thinking-tokens` flag:

From line 28889:
```javascript
if (u !== void 0 && J.push("--max-thinking-tokens", u.toString()))
```

The `getMaxThinkingTokensForModel()` function (line 47198) returns different values based on model.

## Key Implementation Notes

1. **Accumulation:** Thinking deltas stream in fragments and must be accumulated to get the complete thinking block.

2. **Timing:** `thinking_delta` events come during `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_stop` sequence.

3. **Metadata:** The complete assistant message arrives AFTER all stream events, so you get both real-time updates and final confirmed content.

4. **Output Type:** Your plugin already handles this correctly - it emits `outputType: 'thinking'` for thinking content (see line 756 of your plugin).

## References in Extension Code

- **Line 28888-28900:** CLI spawn arguments including `--output-format stream-json`
- **Line 28915-28920:** `setMaxThinkingTokens` control request
- **Line 47198-47224:** `getMaxThinkingTokensForModel` function
- **Line 29192:** Result message type handling
- **Line 59575-59583:** WebSocket message handler (for extension UI)

## Your Current Implementation

Your `claude-sdk-plugin.ts` correctly handles thinking:

1. **Line 747-758:** Captures `thinking_delta` from stream events
2. **Line 917-934:** Captures complete thinking blocks from assistant messages
3. **Line 127-130:** Content block type definition includes `thinking`

Your implementation is already capturing thinking from both sources (streaming and complete messages).
