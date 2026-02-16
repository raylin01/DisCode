import { GeminiClient } from '@raylin01/gemini-client';

const client = new GeminiClient({ cwd: process.cwd(), outputFormat: 'stream-json' });

client.on('ready', (sessionId) => console.log('session', sessionId));
client.on('tool_use', (event) => console.log('tool_use', event.tool_name));
client.on('tool_result', (event) => console.log('tool_result', event.status));
client.on('error_event', (event) => console.error('gemini error event:', event.message));

await client.startSession('Run a short analysis and use tools if needed.');
