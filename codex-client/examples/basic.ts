import { CodexClient } from '@raylin01/codex-client';

const client = new CodexClient({ cwd: process.cwd() });

await client.start();
const threads = await client.listThreads();
console.log('thread count:', threads.data?.length ?? 0);
await client.shutdown();
