# gemini-client

Standalone Node.js client for Gemini CLI (`gemini`) with:

- `stream-json` event handling
- session start/continue via `--resume`
- local session discovery and deletion (`~/.gemini/tmp/<project-hash>/chats`)

## Build

```bash
npm run build
```

## Minimal usage

```ts
import { GeminiClient } from './src/index.js';

const client = new GeminiClient({ cwd: process.cwd(), outputFormat: 'stream-json' });

client.on('message_delta', (chunk) => process.stdout.write(chunk));

const first = await client.startSession('Summarize this repo.');
console.log('session', first.sessionId);

const next = await client.continueSession('Now propose 3 refactors.');
console.log(next.status, next.stats);
```
