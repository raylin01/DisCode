import { CodexClient } from '@raylin01/codex-client';

const client = new CodexClient({ cwd: process.cwd() });

client.on('log', (line) => {
  console.error('[codex-log]', line);
});

try {
  await client.start();
  await client.listModels();
} catch (error) {
  console.error('Codex request failed:', error);
} finally {
  await client.shutdown();
}
