# @raylin01/codex-client

Node.js client for controlling Codex CLI app-server over JSON-RPC.

## Install

```bash
npm install @raylin01/codex-client
```

## Requirements

- Node.js 18+
- Codex CLI available on your PATH (or pass `codexPath`)

## Quickstart

```ts
import { CodexClient } from '@raylin01/codex-client';

const client = new CodexClient({ cwd: process.cwd() });

client.on('ready', () => console.log('Codex app-server ready'));
client.on('notification', (notification) => {
  console.log('Notification:', notification.method);
});

await client.start();
const threads = await client.listThreads();
console.log('threads', threads.data?.length ?? 0);

await client.shutdown();
```

## Event Model

- `ready`: initialize handshake complete
- `request`: incoming JSON-RPC server request requiring a response
- `notification`: incoming JSON-RPC notification
- `log`: stderr output from app-server
- `error`: protocol/process errors

## API

### `new CodexClient(options)`

- `cwd`, `codexPath`, `args`, `env`
- `analyticsDefaultEnabled`
- `clientInfo` and `capabilities`

### Core methods

- `start()` and `shutdown()`
- `sendRequest(method, params)`
- `sendResponse(id, result)`
- `sendError(id, error)`

### Convenience wrappers

- Threads: `startThread`, `resumeThread`, `forkThread`, `listThreads`, `readThread`, ...
- Models: `listModels`, `setDefaultModel`
- Config: `readConfig`, `writeConfigValue`, `batchWriteConfig`
- Turns: `startTurn`, `interruptTurn`

## Examples

See `/examples`:

- `basic.ts`
- `events.ts`
- `error-handling.ts`

## Troubleshooting

- If startup fails, verify `codex app-server` runs from your shell.
- Listen for `log` and `error` events to debug handshake failures.

## Versioning

This package uses independent semver releases.

## Used by DisCode

DisCode uses this package as a real-world integration example:

- [raylin01/DisCode](https://github.com/raylin01/DisCode)

## License

ISC
