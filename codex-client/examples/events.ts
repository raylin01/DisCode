import { CodexClient } from '@raylin01/codex-client';

const client = new CodexClient({ cwd: process.cwd() });

client.on('ready', () => console.log('codex ready'));
client.on('notification', (notification) => {
  console.log('notification:', notification.method);
});
client.on('request', (request) => {
  console.log('request:', request.method);
});
client.on('error', (error) => {
  console.error('error:', error.message);
});

await client.start();
await client.shutdown();
