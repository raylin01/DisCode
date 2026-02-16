import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GeminiClient,
  getGeminiChatsPath,
  listGeminiSessions,
  resolveGeminiSession,
  deleteGeminiSession
} from '../dist/esm/index.js';

async function writeSession(chatsDir, fileName, sessionId, firstUserMessage, updated = '2026-01-01T00:00:00.000Z') {
  const payload = {
    sessionId,
    projectHash: 'hash',
    startTime: '2026-01-01T00:00:00.000Z',
    lastUpdated: updated,
    messages: [
      { type: 'user', content: firstUserMessage },
      { type: 'gemini', content: 'response' }
    ],
    summary: `Summary ${sessionId.slice(0, 4)}`
  };
  await writeFile(join(chatsDir, fileName), JSON.stringify(payload), 'utf8');
}

test('buildArgs prefers run options over client defaults', () => {
  const client = new GeminiClient({
    model: 'default-model',
    outputFormat: 'stream-json',
    includeDirectories: ['/repo']
  });

  const args = client.buildArgs('hello', {
    model: 'override-model',
    outputFormat: 'json',
    includeDirectories: ['/override'],
    extraArgs: ['--foo', 'bar']
  });

  assert.deepEqual(args, [
    '--model', 'override-model',
    '--output-format', 'json',
    '--include-directories', '/override',
    '--foo', 'bar',
    'hello'
  ]);
});

test('session utilities list resolve and delete sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-client-test-'));
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });

  const chatsDir = getGeminiChatsPath({ projectRoot, homeDir: root });
  await mkdir(chatsDir, { recursive: true });

  await writeSession(chatsDir, 'session-a.json', 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa', 'first prompt', '2026-01-01T00:00:00.000Z');
  await writeSession(chatsDir, 'session-b.json', 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb', 'second prompt', '2026-01-02T00:00:00.000Z');

  const listed = await listGeminiSessions({ projectRoot, homeDir: root });
  assert.equal(listed.length, 2);

  const latest = await resolveGeminiSession('latest', { projectRoot, homeDir: root });
  assert.equal(latest.session.id, 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb');

  const removed = await deleteGeminiSession('latest', { projectRoot, homeDir: root });
  assert.equal(removed.id, 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb');

  const remaining = await listGeminiSessions({ projectRoot, homeDir: root });
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa');
});
