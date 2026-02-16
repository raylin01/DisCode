import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CodexClient } from '../dist/esm/index.js';

function makeClientWithStubbedProc() {
  const client = new CodexClient({ cwd: process.cwd() });
  const writes = [];

  client.proc = {
    stdin: {
      destroyed: false,
      write: (line) => {
        writes.push(line);
        return true;
      }
    }
  };

  return { client, writes };
}

test('sendRequest writes JSON-RPC payload', async () => {
  const { client, writes } = makeClientWithStubbedProc();

  const pending = client.sendRequest('thread/list', { limit: 5 });
  const payload = JSON.parse(writes[0]);

  assert.equal(payload.method, 'thread/list');
  assert.deepEqual(payload.params, { limit: 5 });

  client.handleLine(JSON.stringify({ id: payload.id, result: { data: [] } }));
  const result = await pending;
  assert.deepEqual(result, { data: [] });
});

test('sendRequest rejects when response has error', async () => {
  const { client, writes } = makeClientWithStubbedProc();

  const pending = client.sendRequest('thread/list', {});
  const payload = JSON.parse(writes[0]);
  client.handleLine(JSON.stringify({ id: payload.id, error: { message: 'boom' } }));

  await assert.rejects(pending, /boom/);
});

test('handleLine emits notification and request events', () => {
  const { client } = makeClientWithStubbedProc();
  const notifications = [];
  const requests = [];

  client.on('notification', (n) => notifications.push(n));
  client.on('request', (r) => requests.push(r));

  client.handleLine(JSON.stringify({ method: 'thread/started', params: { thread: { id: 't1' } } }));
  client.handleLine(JSON.stringify({ id: 1, method: 'item/tool/requestUserInput', params: { questions: [] } }));

  assert.equal(notifications.length, 1);
  assert.equal(requests.length, 1);
});

test('handleLine emits parse errors for invalid JSON', () => {
  const { client } = makeClientWithStubbedProc();
  const errors = [];

  client.on('error', (error) => errors.push(error));
  client.handleLine('{bad json');

  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Failed to parse codex message/);
});
