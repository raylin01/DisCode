import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSquireTools } from './tools.js';
import type { SquireTool } from './tools.js';

// Mock dependencies
const mockSquire = {
  remember: vi.fn(),
  recall: vi.fn(),
  scheduleTask: vi.fn(),
  cancelTask: vi.fn(),
  getTasks: vi.fn(),
  getSkills: vi.fn(),
  getActiveWorkspace: vi.fn(),
};

const mockSquireBotClient = {
  isConnected: vi.fn(),
  createChannel: vi.fn(),
  sendMessage: vi.fn(),
  renameChannel: vi.fn(),
  createForumPost: vi.fn(),
};

describe('getSquireTools', () => {
  let tools: SquireTool[];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('without SquireBot client', () => {
    beforeEach(() => {
      tools = getSquireTools(mockSquire as never, null);
    });

    it('should return memory tools', () => {
      const memoryRemember = tools.find(t => t.definition.name === 'memory_remember');
      const memoryRecall = tools.find(t => t.definition.name === 'memory_recall');
      const memoryForget = tools.find(t => t.definition.name === 'memory_forget');

      expect(memoryRemember).toBeDefined();
      expect(memoryRecall).toBeDefined();
      expect(memoryForget).toBeDefined();
    });

    it('should return scheduler tools', () => {
      const scheduleTask = tools.find(t => t.definition.name === 'schedule_task');
      const listTasks = tools.find(t => t.definition.name === 'list_tasks');
      const cancelTask = tools.find(t => t.definition.name === 'cancel_task');

      expect(scheduleTask).toBeDefined();
      expect(listTasks).toBeDefined();
      expect(cancelTask).toBeDefined();
    });

    it('should return skills tools', () => {
      const listSkills = tools.find(t => t.definition.name === 'list_skills');
      expect(listSkills).toBeDefined();
    });

    it('should return ticket tools', () => {
      const ticketCreate = tools.find(t => t.definition.name === 'ticket_create');
      const ticketList = tools.find(t => t.definition.name === 'ticket_list');
      const ticketUpdate = tools.find(t => t.definition.name === 'ticket_update');
      const ticketClaim = tools.find(t => t.definition.name === 'ticket_claim');

      expect(ticketCreate).toBeDefined();
      expect(ticketList).toBeDefined();
      expect(ticketUpdate).toBeDefined();
      expect(ticketClaim).toBeDefined();
    });

    it('should NOT return Discord tools without client', () => {
      const discordCreateChannel = tools.find(t => t.definition.name === 'discord_create_channel');
      const discordSendMessage = tools.find(t => t.definition.name === 'discord_send_message');

      expect(discordCreateChannel).toBeUndefined();
      expect(discordSendMessage).toBeUndefined();
    });
  });

  describe('with SquireBot client', () => {
    beforeEach(() => {
      mockSquireBotClient.isConnected.mockReturnValue(true);
      tools = getSquireTools(mockSquire as never, mockSquireBotClient as never);
    });

    it('should return Discord tools when client is connected', () => {
      const discordCreateChannel = tools.find(t => t.definition.name === 'discord_create_channel');
      const discordSendMessage = tools.find(t => t.definition.name === 'discord_send_message');
      const discordRenameChannel = tools.find(t => t.definition.name === 'discord_rename_channel');
      const discordCreateForumPost = tools.find(t => t.definition.name === 'discord_create_forum_post');

      expect(discordCreateChannel).toBeDefined();
      expect(discordSendMessage).toBeDefined();
      expect(discordRenameChannel).toBeDefined();
      expect(discordCreateForumPost).toBeDefined();
    });

    it('should NOT return Discord tools when client is not connected', () => {
      mockSquireBotClient.isConnected.mockReturnValue(false);
      tools = getSquireTools(mockSquire as never, mockSquireBotClient as never);

      const discordCreateChannel = tools.find(t => t.definition.name === 'discord_create_channel');
      expect(discordCreateChannel).toBeUndefined();
    });
  });

  describe('tool handlers', () => {
    beforeEach(() => {
      tools = getSquireTools(mockSquire as never, null);
    });

    describe('memory_remember', () => {
      it('should store memory and return ID', async () => {
        mockSquire.remember.mockResolvedValue({ id: 'mem-123' });

        const tool = tools.find(t => t.definition.name === 'memory_remember')!;
        const result = await tool.handler({ content: 'Test memory', source: 'user' });

        expect(result).toBe('Remembered with ID: mem-123');
        expect(mockSquire.remember).toHaveBeenCalledWith('Test memory', { source: 'user' });
      });

      it('should default source to user', async () => {
        mockSquire.remember.mockResolvedValue({ id: 'mem-456' });

        const tool = tools.find(t => t.definition.name === 'memory_remember')!;
        await tool.handler({ content: 'No source' });

        expect(mockSquire.remember).toHaveBeenCalledWith('No source', { source: 'user' });
      });
    });

    describe('memory_recall', () => {
      it('should return formatted results', async () => {
        mockSquire.recall.mockResolvedValue([
          { entry: { content: 'First result' }, score: 0.9 },
          { entry: { content: 'Second result' }, score: 0.7 },
        ]);

        const tool = tools.find(t => t.definition.name === 'memory_recall')!;
        const result = await tool.handler({ query: 'test', limit: 5 });

        expect(result).toContain('First result');
        expect(result).toContain('0.90');
        expect(mockSquire.recall).toHaveBeenCalledWith('test', 5);
      });

      it('should return message when no results', async () => {
        mockSquire.recall.mockResolvedValue([]);

        const tool = tools.find(t => t.definition.name === 'memory_recall')!;
        const result = await tool.handler({ query: 'nonexistent' });

        expect(result).toBe('No memories found matching your query.');
      });

      it('should default limit to 5', async () => {
        mockSquire.recall.mockResolvedValue([]);

        const tool = tools.find(t => t.definition.name === 'memory_recall')!;
        await tool.handler({ query: 'test' });

        expect(mockSquire.recall).toHaveBeenCalledWith('test', 5);
      });
    });

    describe('schedule_task', () => {
      it('should schedule task and return ID', async () => {
        mockSquire.getActiveWorkspace.mockReturnValue({ workspaceId: 'workspace-1' });
        mockSquire.scheduleTask.mockResolvedValue({
          taskId: 'task-123',
          nextRunAt: '2025-01-01T12:00:00Z',
        });

        const tool = tools.find(t => t.definition.name === 'schedule_task')!;
        const result = await tool.handler({
          description: 'Test task',
          schedule_type: 'interval',
          schedule_value: '60000',
        });

        expect(result).toContain('task-123');
        expect(result).toContain('2025-01-01T12:00:00Z');
      });
    });

    describe('list_tasks', () => {
      it('should list tasks', async () => {
        mockSquire.getTasks.mockReturnValue([
          { status: 'pending', description: 'Task 1', nextRunAt: '2025-01-01T12:00:00Z' },
          { status: 'completed', description: 'Task 2', nextRunAt: '2025-01-02T12:00:00Z' },
        ]);

        const tool = tools.find(t => t.definition.name === 'list_tasks')!;
        const result = await tool.handler({});

        expect(result).toContain('Task 1');
        expect(result).toContain('Task 2');
      });

      it('should return message when no tasks', async () => {
        mockSquire.getTasks.mockReturnValue([]);

        const tool = tools.find(t => t.definition.name === 'list_tasks')!;
        const result = await tool.handler({});

        expect(result).toBe('No scheduled tasks.');
      });
    });

    describe('cancel_task', () => {
      it('should cancel task', async () => {
        mockSquire.cancelTask.mockResolvedValue(undefined);

        const tool = tools.find(t => t.definition.name === 'cancel_task')!;
        const result = await tool.handler({ task_id: 'task-123' });

        expect(result).toBe('Task task-123 cancelled.');
      });
    });

    describe('list_skills', () => {
      it('should list skills', async () => {
        mockSquire.getSkills.mockReturnValue([
          { name: 'memory', description: 'Memory skill' },
          { name: 'web', description: 'Web skill' },
        ]);

        const tool = tools.find(t => t.definition.name === 'list_skills')!;
        const result = await tool.handler({});

        expect(result).toContain('memory');
        expect(result).toContain('web');
      });

      it('should return message when no skills', async () => {
        mockSquire.getSkills.mockReturnValue([]);

        const tool = tools.find(t => t.definition.name === 'list_skills')!;
        const result = await tool.handler({});

        expect(result).toBe('No skills loaded.');
      });
    });
  });

  describe('Discord tool handlers', () => {
    beforeEach(() => {
      mockSquireBotClient.isConnected.mockReturnValue(true);
      tools = getSquireTools(mockSquire as never, mockSquireBotClient as never);
    });

    describe('discord_create_channel', () => {
      it('should create channel', async () => {
        mockSquireBotClient.createChannel.mockResolvedValue({
          success: true,
          data: { channelId: 'channel-123' },
        });

        const tool = tools.find(t => t.definition.name === 'discord_create_channel')!;
        const result = await tool.handler({
          name: 'test-channel',
          guild_id: 'guild-1',
        });

        expect(result).toContain('channel-123');
      });

      it('should handle failure', async () => {
        mockSquireBotClient.createChannel.mockResolvedValue({
          success: false,
          error: 'Permission denied',
        });

        const tool = tools.find(t => t.definition.name === 'discord_create_channel')!;
        const result = await tool.handler({
          name: 'test-channel',
          guild_id: 'guild-1',
        });

        expect(result).toContain('Permission denied');
      });
    });

    describe('discord_send_message', () => {
      it('should send message', async () => {
        mockSquireBotClient.sendMessage.mockResolvedValue({
          success: true,
        });

        const tool = tools.find(t => t.definition.name === 'discord_send_message')!;
        const result = await tool.handler({
          channel_id: 'channel-1',
          content: 'Hello world',
        });

        expect(result).toContain('Message sent');
      });
    });

    describe('discord_rename_channel', () => {
      it('should rename channel', async () => {
        mockSquireBotClient.renameChannel.mockResolvedValue({
          success: true,
        });

        const tool = tools.find(t => t.definition.name === 'discord_rename_channel')!;
        const result = await tool.handler({
          channel_id: 'channel-1',
          name: 'new-name',
        });

        expect(result).toContain('new-name');
      });
    });

    describe('discord_create_forum_post', () => {
      it('should create forum post', async () => {
        mockSquireBotClient.createForumPost.mockResolvedValue({
          success: true,
          data: { postId: 'post-123' },
        });

        const tool = tools.find(t => t.definition.name === 'discord_create_forum_post')!;
        const result = await tool.handler({
          forum_channel_id: 'forum-1',
          title: 'New Post',
          content: 'Content',
        });

        expect(result).toContain('post-123');
      });
    });
  });

  describe('tool definitions', () => {
    beforeEach(() => {
      tools = getSquireTools(mockSquire as never, null);
    });

    it('should have valid JSON schemas', () => {
      for (const tool of tools) {
        expect(tool.definition.input_schema.type).toBe('object');
        expect(tool.definition.input_schema.properties).toBeDefined();
      }
    });

    it('should have required fields defined correctly', () => {
      const memoryRemember = tools.find(t => t.definition.name === 'memory_remember')!;
      expect(memoryRemember.definition.input_schema.required).toContain('content');
    });
  });
});
