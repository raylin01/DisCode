import { GeminiClient } from '@raylin01/gemini-client';

const client = new GeminiClient({ cwd: process.cwd(), outputFormat: 'stream-json' });

try {
  await client.startSession('Generate a short project overview.');
} catch (error) {
  console.error('Gemini execution failed:', error);
} finally {
  await client.shutdown();
}
