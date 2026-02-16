# Phase 7: DisCode Integration

**Goal:** Create a runner-agent plugin that allows DisCode users to access Squire features without running a separate bot.

## Overview

This integration allows DisCode users to:
- Use Squire features via DisCode Bot
- Access global memory across all DisCode sessions
- Schedule background tasks
- Use skills system

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       DISCODE SYSTEM                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                       DISCODE BOT                            ││
│  │  (Multi-tenant Discord bot)                                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                     RUNNER-AGENT                             ││
│  │                                                              ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │                   SQUIRE PLUGIN                         │││
│  │  │  - Wraps @discode/squire                                │││
│  │  │  - Creates workspaces for DisCode threads               │││
│  │  │  - Shares memory across sessions                        │││
│  │  │  - Provides skills to all sessions                      │││
│  │  └─────────────────────────────────────────────────────────┘││
│  │                          │                                   ││
│  │  ┌─────────────────────────────────────────────────────────┐││
│  │  │              EXISTING PLUGINS                           │││
│  │  │  claude-sdk | codex-sdk | gemini-sdk | tmux | ...       │││
│  │  └─────────────────────────────────────────────────────────┘││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
runner-agent/src/
├── squire-plugin/           # NEW
│   ├── index.ts             # Plugin entry point
│   ├── squire-session.ts    # Squire-enhanced session wrapper
│   ├── commands.ts          # Squire commands for DisCode
│   └── tools.ts             # Squire tools to inject
└── plugins/
    └── plugin-manager.ts    # Modified to load squire plugin
```

## Plugin Entry Point (squire-plugin/index.ts)

```typescript
import type { CliPlugin, CliPluginContext } from '../plugins/types.js';
import { Squire } from '@discode/squire';
import type { SquireConfig } from '@discode/squire';
import { SquireSession } from './squire-session.js';
import { getSquireTools } from './tools.js';
import { setupSquireCommands } from './commands.js';

let squireInstance: Squire | null = null;

export const squirePlugin: CliPlugin = {
  name: 'squire',
  version: '1.0.0',

  async initialize(context: CliPluginContext): Promise<void> {
    const config = context.config;

    // Only initialize if Squire is enabled
    if (!config.squire?.enabled) {
      console.log('[SquirePlugin] Squire is disabled');
      return;
    }

    console.log('[SquirePlugin] Initializing...');

    // Create Squire instance
    const squireConfig: Partial<SquireConfig> = {
      squireId: `squire-${context.runnerId}`,
      name: config.squire?.name || 'Squire',
      dataDir: config.squire?.dataDir || path.join(os.homedir(), '.squire', 'data'),
      daemonMode: config.squire?.daemonMode ?? true,
      memory: {
        enabled: config.squire?.memory?.enabled ?? true,
        provider: config.squire?.memory?.provider || 'local',
        retentionDays: config.squire?.memory?.retentionDays || 90
      },
      skills: {
        bundled: config.squire?.skills?.bundled || ['memory', 'web'],
        additional: config.squire?.skills?.additional || [],
        autoInstall: config.squire?.skills?.autoInstall ?? true
      },
      permissions: {
        mode: config.squire?.permissions?.mode || 'confirm',
        allowedTools: config.squire?.permissions?.allowedTools || [],
        blockedTools: config.squire?.permissions?.blockedTools || []
      }
    };

    squireInstance = new Squire(squireConfig);
    await squireInstance.start();

    // Register commands with Discord bot
    if (context.wsManager) {
      setupSquireCommands(context.wsManager, squireInstance);
    }

    console.log('[SquirePlugin] Initialized');
  },

  async createSession(options: any, baseSession: any): Promise<any> {
    if (!squireInstance) {
      return baseSession;
    }

    // Wrap session with Squire enhancements
    return new SquireSession(baseSession, squireInstance, options);
  },

  getAdditionalTools(): any[] {
    if (!squireInstance) {
      return [];
    }

    return getSquireTools(squireInstance);
  },

  async shutdown(): Promise<void> {
    if (squireInstance) {
      await squireInstance.stop();
      squireInstance = null;
    }
  }
};

export function getSquire(): Squire | null {
  return squireInstance;
}
```

## Squire Session Wrapper (squire-plugin/squire-session.ts)

```typescript
import type { PluginSession } from '../plugins/types.js';
import type { Squire, Workspace } from '@discode/squire';

export class SquireSession implements PluginSession {
  private baseSession: PluginSession;
  private squire: Squire;
  private workspace: Workspace;
  private sessionId: string;

  constructor(
    baseSession: PluginSession,
    squire: Squire,
    options: { threadId: string; projectPath: string }
  ) {
    this.baseSession = baseSession;
    this.squire = squire;
    this.sessionId = baseSession.sessionId;

    // Create or get workspace for this session
    this.workspace = this.getOrCreateWorkspace(options);
  }

  private getOrCreateWorkspace(options: { threadId: string; projectPath: string }): Workspace {
    // Check if workspace exists for this DisCode thread
    let workspace = this.squire.getWorkspaceBySource('discode_thread', options.threadId);

    if (!workspace) {
      workspace = this.squire.createWorkspace({
        name: `DisCode: ${options.threadId}`,
        source: 'discode_thread',
        sourceId: options.threadId,
        context: {
          projectPath: options.projectPath
        }
      });
    }

    return workspace;
  }

  // Delegate to base session
  get isActive(): boolean {
    return this.baseSession.isActive;
  }

  async sendMessage(content: string): Promise<void> {
    // Search memory for relevant context
    const memories = await this.squire.recall(content, 3);

    // Augment message with memory context if relevant
    let enhancedContent = content;
    if (memories.length > 0) {
      const memoryContext = memories
        .map(m => `- ${m.entry.content}`)
        .join('\n');

      // Note: We don't modify the user message, but we could inject context
      // into the system prompt via the base session's configuration
    }

    // Send to base session
    await this.baseSession.sendMessage(enhancedContent);
  }

  async sendPermissionDecision(requestId: string, decision: any): Promise<void> {
    return this.baseSession.sendPermissionDecision(requestId, decision);
  }

  async terminate(): Promise<void> {
    // Update workspace status
    this.squire.updateWorkspaceStatus(this.workspace.workspaceId, 'paused');

    return this.baseSession.terminate();
  }

  // Squire-specific methods
  async remember(content: string): Promise<void> {
    await this.squire.remember(content, {
      source: 'user',
      workspaceId: this.workspace.workspaceId
    });
  }

  async recall(query: string, limit?: number) {
    return this.squire.recall(query, limit);
  }

  async scheduleTask(description: string, schedule: any) {
    return this.squire.scheduleTask({
      workspaceId: this.workspace.workspaceId,
      description,
      schedule
    });
  }
}
```

## Squire Tools (squire-plugin/tools.ts)

```typescript
import type { Squire } from '@discode/squire';

export function getSquireTools(squire: Squire): any[] {
  return [
    // Memory tools
    {
      name: 'squire_remember',
      description: 'Store a fact or information in persistent memory. This will be remembered across all future conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'The information to remember'
          }
        },
        required: ['content']
      },
      execute: async (input: { content: string }, context: any) => {
        await squire.remember(input.content, {
          source: 'squire',
          workspaceId: context.workspaceId
        });

        return {
          output: `Remembered: "${input.content}"`,
          success: true
        };
      }
    },

    {
      name: 'squire_recall',
      description: 'Search memories for relevant information. Use this when you need to recall something from previous conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'What to search for in memories'
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results (default: 5)',
            default: 5
          }
        },
        required: ['query']
      },
      execute: async (input: { query: string; limit?: number }, context: any) => {
        const results = await squire.recall(input.query, input.limit || 5);

        if (results.length === 0) {
          return {
            output: 'No relevant memories found.',
            success: true
          };
        }

        const memories = results
          .map((r, i) => `${i + 1}. ${r.entry.content} (score: ${r.score.toFixed(2)})`)
          .join('\n');

        return {
          output: `Found ${results.length} relevant memories:\n${memories}`,
          success: true
        };
      }
    },

    {
      name: 'squire_forget',
      description: 'Remove memories matching a query. Use sparingly.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Which memories to forget'
          }
        },
        required: ['query']
      },
      execute: async (input: { query: string }, context: any) => {
        // Note: This would need to be implemented in Squire
        // For now, return a message
        return {
          output: `Memory deletion is not yet implemented. Query was: "${input.query}"`,
          success: false
        };
      }
    },

    // Scheduling tools
    {
      name: 'squire_schedule',
      description: 'Schedule a task to run in the future. The task will execute even if this session is closed.',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of the task to perform'
          },
          inMinutes: {
            type: 'number',
            description: 'Run in N minutes'
          },
          inHours: {
            type: 'number',
            description: 'Run in N hours'
          }
        },
        required: ['description']
      },
      execute: async (input: { description: string; inMinutes?: number; inHours?: number }, context: any) => {
        const delayMs = (input.inMinutes || 0) * 60 * 1000 + (input.inHours || 0) * 60 * 60 * 1000;

        if (delayMs === 0) {
          return {
            output: 'Please specify either inMinutes or inHours',
            success: false
          };
        }

        const task = await squire.scheduleTask({
          workspaceId: context.workspaceId,
          description: input.description,
          schedule: {
            type: 'interval',
            value: delayMs
          }
        });

        const runAt = new Date(Date.now() + delayMs);

        return {
          output: `Task scheduled! Will run at ${runAt.toLocaleString()}\nTask ID: ${task.taskId}`,
          success: true
        };
      }
    },

    {
      name: 'squire_list_tasks',
      description: 'List all scheduled tasks',
      inputSchema: {
        type: 'object',
        properties: {}
      },
      execute: async (input: any, context: any) => {
        const tasks = squire.getTasks(context.workspaceId);

        if (tasks.length === 0) {
          return {
            output: 'No scheduled tasks.',
            success: true
          };
        }

        const taskList = tasks
          .map((t, i) => `${i + 1}. ${t.description}\n   Next run: ${new Date(t.nextRunAt).toLocaleString()}\n   ID: ${t.taskId}`)
          .join('\n\n');

        return {
          output: `Scheduled tasks:\n\n${taskList}`,
          success: true
        };
      }
    }
  ];
}
```

## DisCode Commands (squire-plugin/commands.ts)

```typescript
import type { WebSocketManager } from '../websocket.js';
import type { Squire } from '@discode/squire';

export function setupSquireCommands(wsManager: WebSocketManager, squire: Squire): void {
  // Register command handlers with the bot via WebSocket

  // /squire start - Start a Squire-enhanced session
  wsManager.on('command:squire_start', async (data: any) => {
    const { threadId, projectPath } = data;

    // Workspace will be created when session starts
    wsManager.send({
      type: 'command_response',
      data: {
        requestId: data.requestId,
        success: true,
        message: 'Squire session started. Memory and scheduling tools are now available.'
      }
    });
  });

  // /squire remember <fact> - Quick memory command
  wsManager.on('command:squire_remember', async (data: any) => {
    const { fact, requestId } = data;

    try {
      await squire.remember(fact, { source: 'user' });

      wsManager.send({
        type: 'command_response',
        data: {
          requestId,
          success: true,
          message: `🧠 Remembered: "${fact}"`
        }
      });
    } catch (error) {
      wsManager.send({
        type: 'command_response',
        data: {
          requestId,
          success: false,
          message: 'Failed to store memory.'
        }
      });
    }
  });

  // /squire recall <query> - Quick memory search
  wsManager.on('command:squire_recall', async (data: any) => {
    const { query, requestId } = data;

    try {
      const results = await squire.recall(query, 5);

      if (results.length === 0) {
        wsManager.send({
          type: 'command_response',
          data: {
            requestId,
            success: true,
            message: 'No memories found matching that query.'
          }
        });
        return;
      }

      const memories = results
        .map((r, i) => `${i + 1}. ${r.entry.content}`)
        .join('\n');

      wsManager.send({
        type: 'command_response',
        data: {
          requestId,
          success: true,
          message: `📚 Found ${results.length} memories:\n${memories}`
        }
      });
    } catch (error) {
      wsManager.send({
        type: 'command_response',
        data: {
          requestId,
          success: false,
          message: 'Failed to search memories.'
        }
      });
    }
  });

  // /squire tasks - List scheduled tasks
  wsManager.on('command:squire_tasks', async (data: any) => {
    const { requestId } = data;

    try {
      const tasks = squire.getTasks();

      if (tasks.length === 0) {
        wsManager.send({
          type: 'command_response',
          data: {
            requestId,
            success: true,
            message: 'No scheduled tasks.'
          }
        });
        return;
      }

      const taskList = tasks
        .slice(0, 10)
        .map((t, i) => `${i + 1}. ${t.description}\n   Next: ${new Date(t.nextRunAt).toLocaleString()}`)
        .join('\n\n');

      wsManager.send({
        type: 'command_response',
        data: {
          requestId,
          success: true,
          message: `📋 Scheduled tasks (${tasks.length}):\n\n${taskList}`
        }
      });
    } catch (error) {
      wsManager.send({
        type: 'command_response',
        data: {
          requestId,
          success: false,
          message: 'Failed to list tasks.'
        }
      });
    }
  });
}
```

## Configuration (runner-agent)

Add to `runner-agent/src/config.ts`:

```typescript
export interface SquirePluginConfig {
  enabled: boolean;
  name?: string;
  dataDir?: string;
  daemonMode?: boolean;

  memory?: {
    enabled?: boolean;
    provider?: 'local' | 'openai';
    retentionDays?: number;
  };

  skills?: {
    bundled?: string[];
    additional?: string[];
    autoInstall?: boolean;
  };

  permissions?: {
    mode?: 'trust' | 'confirm' | 'ask';
    allowedTools?: string[];
    blockedTools?: string[];
  };
}

export interface RunnerConfig {
  // ... existing config ...

  squire?: SquirePluginConfig;
}
```

Example config file:

```json
{
  "runnerId": "my-runner",
  "squire": {
    "enabled": true,
    "name": "Squire",
    "daemonMode": true,
    "memory": {
      "enabled": true,
      "provider": "local",
      "retentionDays": 90
    },
    "skills": {
      "bundled": ["memory", "web", "github"],
      "autoInstall": true
    },
    "permissions": {
      "mode": "confirm"
    }
  }
}
```

## Discord Bot Integration

Add commands to `discord-bot/src/commands/`:

```typescript
// squire.ts
import { SlashCommandBuilder } from 'discord.js';

export const command = new SlashCommandBuilder()
  .setName('squire')
  .setDescription('Squire personal assistant commands')
  .addSubcommand(sub =>
    sub.setName('remember')
      .setDescription('Store a fact in memory')
      .addStringOption(opt =>
        opt.setName('fact')
          .setDescription('The fact to remember')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('recall')
      .setDescription('Search memories')
      .addStringOption(opt =>
        opt.setName('query')
          .setDescription('What to search for')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('tasks')
      .setDescription('List scheduled tasks')
  );
```

## Usage in DisCode

Once integrated, users can:

1. **Via commands:**
   - `/squire remember I prefer TypeScript`
   - `/squire recall coding preferences`
   - `/squire tasks`

2. **Via chat (tools):**
   - "Remember that I like dark mode"
   - "What do you know about my preferences?"
   - "Schedule a reminder to check GitHub issues in 2 hours"

## Testing

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { squirePlugin } from '../dist/squire-plugin/index.js';

test('Plugin initializes with config', async () => {
  const context = {
    config: {
      squire: {
        enabled: true,
        memory: { enabled: true, provider: 'local' }
      }
    },
    runnerId: 'test-runner',
    wsManager: null
  };

  await squirePlugin.initialize(context);

  const squire = getSquire();
  assert.ok(squire);

  await squirePlugin.shutdown();
});

test('Plugin provides tools', () => {
  const tools = squirePlugin.getAdditionalTools();
  assert.ok(tools.length > 0);
  assert.ok(tools.find(t => t.name === 'squire_remember'));
  assert.ok(tools.find(t => t.name === 'squire_recall'));
});
```

## Summary

This integration provides:

1. **Zero-setup for DisCode users** - Just enable in config
2. **Shared memory** - All DisCode sessions share the same memory
3. **Background tasks** - Schedule tasks that persist across sessions
4. **Skills system** - Enhanced capabilities via skills

Users can choose:
- **SquireBot** - Standalone personal bot
- **DisCode + Squire** - Team collaboration with personal assistant features
- **Both** - Use DisCode for team work, SquireBot for personal
