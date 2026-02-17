import { describe, it, expect } from 'vitest';
import { extractCodexStructuredMessages } from '../../src/services/codex-sync';

describe('Codex structured extraction', () => {
  it('maps codex turn items into structured synced messages', () => {
    const thread = {
      id: 'thread-1',
      turns: [
        {
          id: 'turn-1',
          input: [{ type: 'text', text: 'please run tests' }],
          items: [
            { type: 'agentMessage', id: 'agent-1', text: 'Running tests now.' },
            {
              type: 'commandExecution',
              id: 'cmd-1',
              command: 'bun test',
              cwd: '/repo',
              status: 'inProgress',
              aggregatedOutput: ''
            },
            {
              type: 'mcpToolCall',
              id: 'mcp-1',
              server: 'github',
              tool: 'search',
              status: 'completed',
              arguments: { q: 'fix' },
              result: { hits: 3 }
            }
          ]
        }
      ]
    } as any;

    const messages = extractCodexStructuredMessages(thread);
    const blockTypes = messages.map((message: any) => message.content?.[0]?.type);

    expect(blockTypes).toContain('text');
    expect(blockTypes).toContain('tool_use');
    expect(blockTypes).toContain('tool_result');
    expect(blockTypes).toContain('approval_needed');
    expect(messages.some((message: any) => message.id === 'turn-1:cmd-1:2')).toBe(true);
  });

  it('falls back to safe text summary for unknown item types', () => {
    const thread = {
      id: 'thread-2',
      turns: [
        {
          id: 'turn-2',
          items: [
            { type: 'mysteryThing', id: 'mystery-1', payload: { foo: 'bar' } }
          ]
        }
      ]
    } as any;

    const messages = extractCodexStructuredMessages(thread);

    expect(messages.length).toBe(1);
    expect(messages[0].content[0].type).toBe('text');
    expect(messages[0].content[0].text).toContain('mysteryThing');
  });

  it('produces deterministic turn:item:block ids for dedup stability', () => {
    const thread = {
      id: 'thread-3',
      turns: [
        {
          id: 'turn-dedup',
          items: [
            { type: 'agentMessage', id: 'item-a', text: 'A' },
            { type: 'agentMessage', id: 'item-b', text: 'B' }
          ]
        }
      ]
    } as any;

    const first = extractCodexStructuredMessages(thread).map((m: any) => m.id);
    const second = extractCodexStructuredMessages(thread).map((m: any) => m.id);

    expect(first).toEqual(second);
    expect(first).toEqual(['turn-dedup:item-a:0', 'turn-dedup:item-b:0']);
  });
});
