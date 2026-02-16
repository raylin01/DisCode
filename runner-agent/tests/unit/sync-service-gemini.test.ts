import { describe, it, expect, vi } from 'vitest';
import { RunnerSyncService } from '../../src/services/sync-service';

describe('RunnerSyncService gemini structured extraction', () => {
  function createService(): RunnerSyncService {
    const wsManager = {
      runnerId: 'runner-1',
      send: vi.fn()
    } as any;
    return new RunnerSyncService(wsManager, { codexPath: null });
  }

  it('maps Gemini messages into structured synced blocks', () => {
    const service = createService();
    const transcript = [
      {
        id: 'm1',
        type: 'user',
        timestamp: '2026-02-16T10:00:00.000Z',
        content: 'check files'
      },
      {
        id: 'm2',
        type: 'gemini',
        timestamp: '2026-02-16T10:00:01.000Z',
        content: 'I will inspect the workspace.',
        thoughts: [{ subject: 'Plan', description: 'Inspect tree then summarize.' }],
        toolCalls: [
          {
            id: 'tool-1',
            name: 'run_shell',
            args: { command: 'ls -la' },
            status: 'completed',
            result: [{ functionResponse: { response: { output: 'fileA\nfileB' } } }]
          }
        ]
      },
      {
        id: 'm3',
        type: 'gemini',
        timestamp: '2026-02-16T10:00:02.000Z',
        toolCalls: [
          {
            id: 'tool-2',
            name: 'edit_file',
            args: { path: 'src/a.ts' },
            status: 'inProgress'
          }
        ]
      }
    ];

    const messages = (service as any).extractGeminiStructuredMessages(transcript, 'session-1');
    const blockTypes = messages.map((message: any) => message.content?.[0]?.type);

    expect(blockTypes).toContain('text');
    expect(blockTypes).toContain('thinking');
    expect(blockTypes).toContain('tool_use');
    expect(blockTypes).toContain('tool_result');
    expect(blockTypes).toContain('approval_needed');
    expect(messages.some((message: any) => message.id === 'gemini-session-1:m3:1')).toBe(true);
  });

  it('falls back to safe text summary for unknown Gemini entries', () => {
    const service = createService();
    const transcript = [
      {
        id: 'm4',
        type: 'info',
        payload: { stage: 'syncing' }
      }
    ];

    const messages = (service as any).extractGeminiStructuredMessages(transcript, 'session-2');

    expect(messages.length).toBe(1);
    expect(messages[0].content[0].type).toBe('text');
    expect(messages[0].content[0].text).toContain('[info]');
  });

  it('produces deterministic ids for Gemini structured extraction', () => {
    const service = createService();
    const transcript = [
      { id: 'a', type: 'user', content: 'A' },
      { id: 'b', type: 'gemini', content: 'B' }
    ];

    const first = (service as any).extractGeminiStructuredMessages(transcript, 'session-det').map((m: any) => m.id);
    const second = (service as any).extractGeminiStructuredMessages(transcript, 'session-det').map((m: any) => m.id);

    expect(first).toEqual(second);
    expect(first).toEqual(['gemini-session-det:a:0', 'gemini-session-det:b:0']);
  });
});
