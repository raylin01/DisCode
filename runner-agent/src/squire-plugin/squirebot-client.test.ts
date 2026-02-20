import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SquireBotClient } from './squirebot-client.js';

// Mock WebSocket
vi.mock('ws', () => {
  const mockWs = vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  }));
  return { default: mockWs };
});

describe('SquireBotClient', () => {
  let client: SquireBotClient;
  let mockWs: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { default: WS } = await import('ws');
    mockWs = vi.mocked(WS);
    client = new SquireBotClient('ws://localhost:3123', 'test-token');
  });

  afterEach(() => {
    client.disconnect();
  });

  describe('constructor', () => {
    it('should create client with URL and token', () => {
      expect(client).toBeInstanceOf(SquireBotClient);
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('connect', () => {
    it('should create WebSocket connection', async () => {
      const connectPromise = client.connect();

      expect(mockWs).toHaveBeenCalledWith('ws://localhost:3123');

      // Simulate auth success
      const wsInstance = mockWs.mock.results[0].value;
      const openHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'open'
      )?.[1];

      if (openHandler) {
        openHandler();
      }

      // Simulate auth_success message
      const messageHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'auth_success' })));
      }

      await connectPromise;
      expect(client.isConnected()).toBe(true);
    });

    it('should send auth message on connect', async () => {
      const connectPromise = client.connect();

      const wsInstance = mockWs.mock.results[0].value;
      const openHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'open'
      )?.[1];

      if (openHandler) {
        openHandler();
      }

      expect(wsInstance.send).toHaveBeenCalledWith(
        JSON.stringify({ type: 'auth', data: { token: 'test-token' } })
      );

      // Complete connection
      const messageHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      )?.[1];

      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'auth_success' })));
      }

      await connectPromise;
    });
  });

  describe('disconnect', () => {
    it('should close WebSocket connection', async () => {
      // First connect
      const connectPromise = client.connect();
      const wsInstance = mockWs.mock.results[0].value;

      const openHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'open'
      )?.[1];
      const messageHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      )?.[1];

      if (openHandler) openHandler();
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'auth_success' })));
      }

      await connectPromise;

      // Now disconnect
      client.disconnect();

      expect(wsInstance.close).toHaveBeenCalled();
      expect(client.isConnected()).toBe(false);
    });

    it('should be safe to call when not connected', () => {
      client.disconnect(); // Should not throw
    });
  });

  describe('isConnected', () => {
    it('should return false initially', () => {
      expect(client.isConnected()).toBe(false);
    });
  });

  describe('operations', () => {
    beforeEach(async () => {
      const connectPromise = client.connect();
      const wsInstance = mockWs.mock.results[0].value;

      const openHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'open'
      )?.[1];
      const messageHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      )?.[1];

      if (openHandler) openHandler();
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'auth_success' })));
      }

      await connectPromise;
    });

    describe('createChannel', () => {
      it('should send create_channel operation', async () => {
        const wsInstance = mockWs.mock.results[0].value;
        wsInstance.send.mockClear();

        const resultPromise = client.createChannel({
          name: 'test-channel',
          guildId: 'guild-123',
        });

        // Check operation was sent
        const sentData = JSON.parse(wsInstance.send.mock.calls[0][0]);
        expect(sentData.type).toBe('create_channel');
        expect(sentData.data.name).toBe('test-channel');

        // Simulate response
        const messageHandler = wsInstance.on.mock.calls.find(
          (call: unknown[]) => call[0] === 'message'
        )?.[1];

        if (messageHandler) {
          messageHandler(Buffer.from(JSON.stringify({
            type: 'operation_result',
            data: {
              requestId: sentData.requestId,
              success: true,
              data: { channelId: 'channel-456' },
            },
          })));
        }

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.data?.channelId).toBe('channel-456');
      });
    });

    describe('sendMessage', () => {
      it('should send send_message operation', async () => {
        const wsInstance = mockWs.mock.results[0].value;
        wsInstance.send.mockClear();

        const resultPromise = client.sendMessage({
          channelId: 'channel-456',
          content: 'Hello world',
        });

        const sentData = JSON.parse(wsInstance.send.mock.calls[0][0]);
        expect(sentData.type).toBe('send_message');
        expect(sentData.data.channelId).toBe('channel-456');
        expect(sentData.data.content).toBe('Hello world');

        // Simulate response
        const messageHandler = wsInstance.on.mock.calls.find(
          (call: unknown[]) => call[0] === 'message'
        )?.[1];

        if (messageHandler) {
          messageHandler(Buffer.from(JSON.stringify({
            type: 'operation_result',
            data: {
              requestId: sentData.requestId,
              success: true,
            },
          })));
        }

        const result = await resultPromise;
        expect(result.success).toBe(true);
      });

      it('should include embed options', async () => {
        const wsInstance = mockWs.mock.results[0].value;
        wsInstance.send.mockClear();

        const resultPromise = client.sendMessage({
          channelId: 'channel-456',
          content: 'Test',
          embed: {
            title: 'Title',
            description: 'Description',
            color: 'green',
          },
        });

        const sentData = JSON.parse(wsInstance.send.mock.calls[0][0]);
        expect(sentData.data.embed).toEqual({
          title: 'Title',
          description: 'Description',
          color: 'green',
        });

        // Complete promise
        const messageHandler = wsInstance.on.mock.calls.find(
          (call: unknown[]) => call[0] === 'message'
        )?.[1];

        if (messageHandler) {
          messageHandler(Buffer.from(JSON.stringify({
            type: 'operation_result',
            data: { requestId: sentData.requestId, success: true },
          })));
        }

        await resultPromise;
      });
    });

    describe('renameChannel', () => {
      it('should send rename_channel operation', async () => {
        const wsInstance = mockWs.mock.results[0].value;
        wsInstance.send.mockClear();

        const resultPromise = client.renameChannel({
          channelId: 'channel-456',
          name: 'new-name',
        });

        const sentData = JSON.parse(wsInstance.send.mock.calls[0][0]);
        expect(sentData.type).toBe('rename_channel');
        expect(sentData.data.name).toBe('new-name');

        // Simulate response
        const messageHandler = wsInstance.on.mock.calls.find(
          (call: unknown[]) => call[0] === 'message'
        )?.[1];

        if (messageHandler) {
          messageHandler(Buffer.from(JSON.stringify({
            type: 'operation_result',
            data: { requestId: sentData.requestId, success: true },
          })));
        }

        const result = await resultPromise;
        expect(result.success).toBe(true);
      });
    });

    describe('createForumPost', () => {
      it('should send create_forum_post operation', async () => {
        const wsInstance = mockWs.mock.results[0].value;
        wsInstance.send.mockClear();

        const resultPromise = client.createForumPost({
          forumChannelId: 'forum-123',
          title: 'New Post',
          content: 'Post content',
          tags: ['bug', 'urgent'],
        });

        const sentData = JSON.parse(wsInstance.send.mock.calls[0][0]);
        expect(sentData.type).toBe('create_forum_post');
        expect(sentData.data.title).toBe('New Post');
        expect(sentData.data.tags).toEqual(['bug', 'urgent']);

        // Simulate response
        const messageHandler = wsInstance.on.mock.calls.find(
          (call: unknown[]) => call[0] === 'message'
        )?.[1];

        if (messageHandler) {
          messageHandler(Buffer.from(JSON.stringify({
            type: 'operation_result',
            data: {
              requestId: sentData.requestId,
              success: true,
              data: { postId: 'post-789' },
            },
          })));
        }

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.data?.postId).toBe('post-789');
      });
    });
  });

  describe('error handling', () => {
    it('should throw when operation sent while not connected', async () => {
      await expect(client.createChannel({
        name: 'test',
        guildId: 'guild-1',
      })).rejects.toThrow('Not connected');
    });

    it('should handle auth_error', async () => {
      const connectPromise = client.connect();
      const wsInstance = mockWs.mock.results[0].value;

      const openHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'open'
      )?.[1];
      const messageHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      )?.[1];

      if (openHandler) openHandler();
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'auth_error' })));
      }

      await expect(connectPromise).rejects.toThrow('Authentication failed');
    });

    it('should handle operation errors', async () => {
      const connectPromise = client.connect();
      const wsInstance = mockWs.mock.results[0].value;

      const openHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'open'
      )?.[1];
      const messageHandler = wsInstance.on.mock.calls.find(
        (call: unknown[]) => call[0] === 'message'
      )?.[1];

      if (openHandler) openHandler();
      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({ type: 'auth_success' })));
      }

      await connectPromise;

      wsInstance.send.mockClear();
      const resultPromise = client.sendMessage({
        channelId: 'channel-1',
        content: 'Test',
      });

      const sentData = JSON.parse(wsInstance.send.mock.calls[0][0]);

      if (messageHandler) {
        messageHandler(Buffer.from(JSON.stringify({
          type: 'operation_result',
          data: {
            requestId: sentData.requestId,
            success: false,
            error: 'Channel not found',
          },
        })));
      }

      const result = await resultPromise;
      expect(result.success).toBe(false);
      expect(result.error).toBe('Channel not found');
    });
  });
});
