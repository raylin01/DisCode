import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionSyncService } from '../../src/services/session-sync';
import { storage } from '../../src/storage';
import * as embeds from '../../src/utils/embeds';

describe('SessionSyncService postSessionMessages', () => {
  const runnerId = 'runner-1';

  beforeEach(() => {
    vi.spyOn(storage, 'getRunner').mockReturnValue({
      runnerId,
      name: 'Runner One'
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders assistant synced text via Agent Output embed', async () => {
    const service = new SessionSyncService({} as any);
    const sent: any[] = [];
    // Mock the queueManager's sendThreadMessage method
    (service as any).queueManager.sendThreadMessage = vi.fn(async (_thread: any, payload: any) => {
      sent.push(payload);
    });

    const outputSpy = vi.spyOn(embeds, 'createOutputEmbed');

    await service.postSessionMessages(
      runnerId,
      { id: 'thread-1' } as any,
      [{ role: 'assistant', content: [{ type: 'text', text: 'hello from sync' }] }]
    );

    expect(outputSpy).toHaveBeenCalledWith('stdout', 'hello from sync');
    expect(sent.length).toBe(1);
    expect(sent[0].embeds).toBeTruthy();
  });

  it('renders tool_use and tool_result blocks as embeds', async () => {
    const service = new SessionSyncService({} as any);
    const sent: any[] = [];
    (service as any).queueManager.sendThreadMessage = vi.fn(async (_thread: any, payload: any) => {
      sent.push(payload);
    });

    await service.postSessionMessages(
      runnerId,
      { id: 'thread-2' } as any,
      [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', name: 'CommandExecution', input: { command: 'ls -la' } },
            { type: 'tool_result', content: 'ok', is_error: false }
          ]
        }
      ]
    );

    expect(sent.length).toBe(2);
    expect(sent[0].embeds).toBeTruthy();
    expect(sent[1].embeds).toBeTruthy();
  });

  it('renders approval_needed with attach button for sync format v2', async () => {
    const service = new SessionSyncService({} as any);
    const sent: any[] = [];
    (service as any).queueManager.sendThreadMessage = vi.fn(async (_thread: any, payload: any) => {
      sent.push(payload);
    });

    await service.postSessionMessages(
      runnerId,
      { id: 'thread-3' } as any,
      [
        {
          role: 'assistant',
          content: [
            {
              type: 'approval_needed',
              title: 'Approval may be required',
              description: 'Attach to approve tool requests',
              requiresAttach: true
            }
          ]
        }
      ],
      2
    );

    expect(sent.length).toBe(1);
    expect(sent[0].embeds).toBeTruthy();
    expect(sent[0].components?.[0]?.components?.[0]?.data?.custom_id).toBe('sync_attach_control');
  });

  it('renders Claude transcript wrapper messages with tool embeds and Agent Output text', async () => {
    const service = new SessionSyncService({} as any);
    const sent: any[] = [];
    (service as any).queueManager.sendThreadMessage = vi.fn(async (_thread: any, payload: any) => {
      sent.push(payload);
    });

    await service.postSessionMessages(
      runnerId,
      { id: 'thread-4' } as any,
      [
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: "I'll run that command for you." }]
          }
        },
        {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'echo test' } }]
          }
        },
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'test', is_error: false }]
          }
        }
      ]
    );

    expect(sent.length).toBe(3);
    expect(sent[0].embeds?.[0]?.data?.title).toBe('Agent Output');
    expect(sent[1].embeds).toBeTruthy();
    expect(sent[2].embeds?.[0]?.data?.title).toBe('Tool Result');
  });
});
