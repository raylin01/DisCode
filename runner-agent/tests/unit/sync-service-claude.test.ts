import { describe, it, expect } from 'vitest';
import { extractClaudeStructuredMessages } from '../../src/services/claude-sync';

describe('Claude structured extraction', () => {
  it('maps Claude transcript records into structured synced blocks', () => {
    const transcript = [
      { type: 'queue-operation', operation: 'dequeue' },
      {
        type: 'user',
        sessionId: 'session-1',
        uuid: 'u1',
        timestamp: '2026-02-16T10:00:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'run tests' }]
        }
      },
      {
        type: 'assistant',
        sessionId: 'session-1',
        uuid: 'u2',
        timestamp: '2026-02-16T10:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_done', name: 'Bash', input: { command: 'bun test' } }]
        }
      },
      {
        type: 'user',
        sessionId: 'session-1',
        uuid: 'u3',
        timestamp: '2026-02-16T10:00:02.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_done', content: 'ok', is_error: false }]
        }
      },
      {
        type: 'assistant',
        sessionId: 'session-1',
        uuid: 'u4',
        timestamp: '2026-02-16T10:00:03.000Z',
        todos: [{ id: 't1', content: 'Write tests', status: 'in_progress' }],
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Need to add tests before merge.' }]
        }
      },
      {
        type: 'assistant',
        sessionId: 'session-1',
        uuid: 'u5',
        timestamp: '2026-02-16T10:00:04.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_pending', name: 'Edit', input: { file: 'a.ts' } }]
        }
      }
    ];

    const messages = extractClaudeStructuredMessages(transcript);
    const blockTypes = messages.map((message: any) => message.content?.[0]?.type);

    expect(blockTypes).toContain('text');
    expect(blockTypes).toContain('tool_use');
    expect(blockTypes).toContain('tool_result');
    expect(blockTypes).toContain('thinking');
    expect(blockTypes).toContain('plan');
    expect(blockTypes).toContain('approval_needed');
    expect(messages.some((message: any) => message.id === 'claude-session-1:u5-approval:0')).toBe(true);
  });

  it('produces deterministic ids for Claude structured extraction', () => {
    const transcript = [
      {
        type: 'assistant',
        sessionId: 'session-det',
        uuid: 'uuid-a',
        timestamp: '2026-02-16T10:01:00.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'A' }]
        }
      },
      {
        type: 'assistant',
        sessionId: 'session-det',
        uuid: 'uuid-b',
        timestamp: '2026-02-16T10:01:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'B' }]
        }
      }
    ];

    const first = extractClaudeStructuredMessages(transcript).map((message: any) => message.id);
    const second = extractClaudeStructuredMessages(transcript).map((message: any) => message.id);

    expect(first).toEqual(second);
    expect(first).toEqual(['claude-session-det:uuid-a:0', 'claude-session-det:uuid-b:0']);
  });
});
