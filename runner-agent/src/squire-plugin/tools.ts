/**
 * Squire Tools
 *
 * Provides Squire-related tools to the AI agent.
 */

import type { Squire } from '../../../squire/squire/src/index.js';
import type { SquireBotClient } from './squirebot-client.js';

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, {
      type: string;
      description: string;
      enum?: string[];
    }>;
    required?: string[];
  };
}

export interface ToolHandler {
  (input: Record<string, unknown>): Promise<string>;
}

export interface SquireTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

export function getSquireTools(squire: Squire, squireBotClient: SquireBotClient | null): SquireTool[] {
  const tools: SquireTool[] = [];

  // Memory Tools
  tools.push({
    definition: {
      name: 'memory_remember',
      description: 'Store a fact or piece of information in long-term memory for later recall',
      input_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember',
          },
          source: {
            type: 'string',
            description: 'Source of the memory',
            enum: ['user', 'squire', 'skill', 'document'],
          },
        },
        required: ['content'],
      },
    },
    handler: async (input) => {
      const content = input.content as string;
      const source = (input.source as 'user' | 'squire' | 'skill' | 'document') || 'user';

      const entry = await squire.remember(content, { source });
      return `Remembered with ID: ${entry.id}`;
    },
  });

  tools.push({
    definition: {
      name: 'memory_recall',
      description: 'Search memories for relevant information using semantic search',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in memories',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default: 5)',
          },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const query = input.query as string;
      const limit = (input.limit as number) || 5;

      const results = await squire.recall(query, limit);

      if (results.length === 0) {
        return 'No memories found matching your query.';
      }

      return results.map((r, i) =>
        `${i + 1}. [Score: ${r.score.toFixed(2)}] ${r.entry.content}`
      ).join('\n\n');
    },
  });

  tools.push({
    definition: {
      name: 'memory_forget',
      description: 'Remove memories matching a query from long-term memory',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Which memories to forget',
          },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      // This would need to be implemented in the memory manager
      return 'Forget operation not yet implemented';
    },
  });

  // Scheduler Tools
  tools.push({
    definition: {
      name: 'schedule_task',
      description: 'Schedule a task to run in the future. Requires daemon mode.',
      input_schema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of the task to perform',
          },
          schedule_type: {
            type: 'string',
            description: 'Type of schedule',
            enum: ['once', 'interval', 'cron'],
          },
          schedule_value: {
            type: 'string',
            description: 'Schedule value: ISO date for once, milliseconds for interval, cron expression for cron',
          },
        },
        required: ['description', 'schedule_type', 'schedule_value'],
      },
    },
    handler: async (input) => {
      const description = input.description as string;
      const scheduleType = input.schedule_type as 'once' | 'interval' | 'cron';
      const scheduleValue = input.schedule_value as string | number;

      const task = await squire.scheduleTask({
        workspaceId: squire.getActiveWorkspace()?.workspaceId || 'default',
        description,
        schedule: {
          type: scheduleType,
          value: scheduleType === 'interval' ? parseInt(String(scheduleValue), 10) : scheduleValue,
        },
      });

      return `Task scheduled with ID: ${task.taskId}. Next run: ${task.nextRunAt}`;
    },
  });

  tools.push({
    definition: {
      name: 'list_tasks',
      description: 'List scheduled tasks',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    handler: async () => {
      const tasks = squire.getTasks();

      if (tasks.length === 0) {
        return 'No scheduled tasks.';
      }

      return tasks.map((t, i) =>
        `${i + 1}. [${t.status}] ${t.description} - Next: ${t.nextRunAt}`
      ).join('\n');
    },
  });

  tools.push({
    definition: {
      name: 'cancel_task',
      description: 'Cancel a scheduled task',
      input_schema: {
        type: 'object',
        properties: {
          task_id: {
            type: 'string',
            description: 'ID of the task to cancel',
          },
        },
        required: ['task_id'],
      },
    },
    handler: async (input) => {
      const taskId = input.task_id as string;
      await squire.cancelTask(taskId);
      return `Task ${taskId} cancelled.`;
    },
  });

  // Channel Tools (via SquireBot)
  if (squireBotClient?.isConnected()) {
    tools.push({
      definition: {
        name: 'discord_create_channel',
        description: 'Create a new Discord channel',
        input_schema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the new channel',
            },
            guild_id: {
              type: 'string',
              description: 'Discord guild/server ID',
            },
            topic: {
              type: 'string',
              description: 'Optional topic/description for the channel',
            },
          },
          required: ['name', 'guild_id'],
        },
      },
      handler: async (input) => {
        const result = await squireBotClient.createChannel({
          name: input.name as string,
          guildId: input.guild_id as string,
          topic: input.topic as string | undefined,
        });

        if (result.success) {
          return `Channel created: ${result.data?.channelId}`;
        }
        return `Failed to create channel: ${result.error}`;
      },
    });

    tools.push({
      definition: {
        name: 'discord_send_message',
        description: 'Send a message to a Discord channel',
        input_schema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'Discord channel ID',
            },
            content: {
              type: 'string',
              description: 'Message content',
            },
            embed_title: {
              type: 'string',
              description: 'Optional embed title',
            },
            embed_description: {
              type: 'string',
              description: 'Optional embed description',
            },
            embed_color: {
              type: 'string',
              description: 'Embed color: green, red, yellow, blue, orange, purple',
            },
          },
          required: ['channel_id', 'content'],
        },
      },
      handler: async (input) => {
        const result = await squireBotClient.sendMessage({
          channelId: input.channel_id as string,
          content: input.content as string,
          embed: input.embed_title ? {
            title: input.embed_title as string,
            description: input.embed_description as string | undefined,
            color: input.embed_color as string | undefined,
          } : undefined,
        });

        if (result.success) {
          return `Message sent to channel ${input.channel_id}`;
        }
        return `Failed to send message: ${result.error}`;
      },
    });

    tools.push({
      definition: {
        name: 'discord_rename_channel',
        description: 'Rename a Discord channel',
        input_schema: {
          type: 'object',
          properties: {
            channel_id: {
              type: 'string',
              description: 'Discord channel ID',
            },
            name: {
              type: 'string',
              description: 'New name for the channel',
            },
          },
          required: ['channel_id', 'name'],
        },
      },
      handler: async (input) => {
        const result = await squireBotClient.renameChannel({
          channelId: input.channel_id as string,
          name: input.name as string,
        });

        if (result.success) {
          return `Channel renamed to ${input.name}`;
        }
        return `Failed to rename channel: ${result.error}`;
      },
    });

    tools.push({
      definition: {
        name: 'discord_create_forum_post',
        description: 'Create a new post in a Discord forum channel',
        input_schema: {
          type: 'object',
          properties: {
            forum_channel_id: {
              type: 'string',
              description: 'Discord forum channel ID',
            },
            title: {
              type: 'string',
              description: 'Post title',
            },
            content: {
              type: 'string',
              description: 'Post content',
            },
            tags: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional tags to apply',
            },
          },
          required: ['forum_channel_id', 'title', 'content'],
        },
      },
      handler: async (input) => {
        const result = await squireBotClient.createForumPost({
          forumChannelId: input.forum_channel_id as string,
          title: input.title as string,
          content: input.content as string,
          tags: input.tags as string[] | undefined,
        });

        if (result.success) {
          return `Forum post created: ${result.data?.postId}`;
        }
        return `Failed to create forum post: ${result.error}`;
      },
    });
  }

  // Skills Tools
  tools.push({
    definition: {
      name: 'list_skills',
      description: 'List available skills',
      input_schema: {
        type: 'object',
        properties: {},
      },
    },
    handler: async () => {
      const skills = squire.getSkills();

      if (skills.length === 0) {
        return 'No skills loaded.';
      }

      return skills.map((s, i) =>
        `${i + 1}. ${s.name}${s.description ? `: ${s.description}` : ''}`
      ).join('\n');
    },
  });

  // Ticket Tools (Phase 8)
  tools.push({
    definition: {
      name: 'ticket_create',
      description: 'Create a new ticket for tracking bugs, features, or tasks',
      input_schema: {
        type: 'object',
        properties: {
          title: {
            type: 'string',
            description: 'Ticket title',
          },
          description: {
            type: 'string',
            description: 'Detailed description of the ticket',
          },
          type: {
            type: 'string',
            description: 'Type of ticket',
            enum: ['bug', 'feature', 'question', 'task'],
          },
          priority: {
            type: 'string',
            description: 'Priority level',
            enum: ['low', 'normal', 'high', 'urgent'],
          },
        },
        required: ['title', 'description'],
      },
    },
    handler: async (input) => {
      // This would need a TicketManager instance
      return 'Ticket creation requires TicketManager to be initialized';
    },
  });

  tools.push({
    definition: {
      name: 'ticket_list',
      description: 'List tickets, optionally filtered by status or assignee',
      input_schema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Filter by status',
            enum: ['open', 'triage', 'in_progress', 'blocked', 'review', 'done', 'wontfix', 'duplicate'],
          },
          assignee: {
            type: 'string',
            description: 'Filter by assignee',
            enum: ['unassigned', 'ai', 'user'],
          },
          limit: {
            type: 'number',
            description: 'Maximum number of tickets to return',
          },
        },
      },
    },
    handler: async (input) => {
      // This would need a TicketManager instance
      return 'Ticket listing requires TicketManager to be initialized';
    },
  });

  tools.push({
    definition: {
      name: 'ticket_update',
      description: 'Update a ticket status or assignment',
      input_schema: {
        type: 'object',
        properties: {
          ticket_id: {
            type: 'string',
            description: 'Ticket ID to update',
          },
          status: {
            type: 'string',
            description: 'New status',
            enum: ['open', 'triage', 'in_progress', 'blocked', 'review', 'done', 'wontfix', 'duplicate'],
          },
          assignee: {
            type: 'string',
            description: 'New assignee',
            enum: ['unassigned', 'ai', 'user'],
          },
        },
        required: ['ticket_id'],
      },
    },
    handler: async (input) => {
      // This would need a TicketManager instance
      return `Ticket update requires TicketManager to be initialized`;
    },
  });

  tools.push({
    definition: {
      name: 'ticket_claim',
      description: 'Claim a ticket to work on it (assign to AI)',
      input_schema: {
        type: 'object',
        properties: {
          ticket_id: {
            type: 'string',
            description: 'Ticket ID to claim',
          },
        },
        required: ['ticket_id'],
      },
    },
    handler: async (input) => {
      // This would need a TicketManager instance
      return `Ticket claiming requires TicketManager to be initialized`;
    },
  });

  return tools;
}
