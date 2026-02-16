# @raylin01/gemini-client

Node.js client for Gemini CLI with stream-json event handling and local session discovery.

## Install

```bash
npm install @raylin01/gemini-client
```

## Requirements

- Node.js 18+
- Gemini CLI installed and authenticated

## Quickstart

```ts
import { GeminiClient } from '@raylin01/gemini-client';

const client = new GeminiClient({
  cwd: process.cwd(),
  outputFormat: 'stream-json'
});

client.on('message_delta', (delta) => process.stdout.write(delta));

const first = await client.startSession('Summarize this repository.');
console.log('\nSession:', first.sessionId);

const next = await client.continueSession('Now propose 3 refactors.');
console.log('Status:', next.status);
```

## Event Model

- `ready`: session established with `sessionId`
- `event`: raw stream-json event
- `message_delta`: assistant token deltas
- `tool_use`, `tool_result`: tool lifecycle
- `result`: run completion
- `error_event`: structured Gemini warning/error event
- `stderr`, `stdout`, `exit`

## API

### `new GeminiClient(options)`

- `cwd`, `geminiPath`, `env`, `args`
- `model`, `outputFormat`, `approvalMode`, `yolo`
- sandbox/tool include options

### Core methods

- `startSession(prompt, runOptions?)`
- `continueSession(prompt, runOptions?)`
- `sendMessage(prompt, runOptions?)`
- `interrupt(signal?)`
- `shutdown()`

### Session helpers

- `listSessions()`
- `resolveSession(identifier)`
- `deleteSession(identifier)`

And utility subpath export:

- `@raylin01/gemini-client/sessions`

## Examples

See `/examples`:

- `basic.ts`
- `events.ts`
- `error-handling.ts`

## Troubleshooting

- Use `stream-json` output for robust structured integration.
- If no sessions are found, verify `~/.gemini/tmp/<project-hash>/chats` exists.

## Versioning

This package uses independent semver releases.

## Used by DisCode

DisCode uses this package as a real-world integration example:

- [raylin01/DisCode](https://github.com/raylin01/DisCode)

## License

ISC
