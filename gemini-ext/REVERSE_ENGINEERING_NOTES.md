# Gemini Reverse Engineering Notes (v2.70.0 VSIX + Gemini CLI 0.24.0)

## What was unpacked and beautified

- VSIX unpacked to: `gemini-ext/`
- Extension bundle:
  - Raw: `gemini-ext/extension/dist/extension.js`
  - Beautified: `gemini-ext/extension/dist/extension.pretty.js`
- Local A2A server bundle:
  - Raw: `gemini-ext/extension/agent/a2a-server.mjs`
  - Beautified: `gemini-ext/extension/agent/a2a-server.pretty.mjs`

## Key session lifecycle findings

### VS Code extension protocol (Gemini Code Assist)

The extension’s internal RPC routes show chat thread lifecycle primitives:

- `conversation/startSession`
- `conversation/chat`
- `conversation/resume`
- `conversation/chat/getHistory`
- `conversation/chat/updateHistory`
- `conversation/fork`

Observed behavior in extension logic:

- New chat sets/updates an active thread ID.
- Resume path uses persisted thread/history payload.
- History update persists thread state and associated context metadata.

### Gemini CLI session behavior (0.24.0)

CLI options relevant to start/continue:

- `--resume <identifier>`
  - supports `latest`, numeric index, or UUID
- `--list-sessions`
- `--delete-session <identifier>`
- `--output-format stream-json`

Session persistence model (from installed `@google/gemini-cli-core`):

- Session files are stored in:
  - `~/.gemini/tmp/<sha256(projectRoot)>/chats/session-*.json`
- Conversation schema includes:
  - `sessionId`, `startTime`, `lastUpdated`, `messages[]`, optional `summary`

## stream-json contract used for client implementation

Event types:

- `init`
- `message`
- `tool_use`
- `tool_result`
- `error`
- `result`

Important fields:

- `init.session_id` (stable session UUID for resume)
- `message.role` + incremental `message.content` with optional `delta`
- `result.status` and `result.stats`

## Outcome in this repo

A new `gemini-client` package was implemented to match the same client-layer goal as `claude-client` and `codex-client`, with:

- session start/continue
- session listing/resolution/deletion
- `stream-json` event parsing and typed event emission
