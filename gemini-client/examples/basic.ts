import { GeminiClient } from '@raylin01/gemini-client';

const client = new GeminiClient({ cwd: process.cwd(), outputFormat: 'stream-json' });

client.on('message_delta', (delta) => process.stdout.write(delta));

const result = await client.startSession('Summarize this repository.');
console.log('\nstatus:', result.status, 'session:', result.sessionId);
