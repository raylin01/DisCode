# Phase 1: Core Package Foundation

**Goal:** Create the `@discode/squire` package with basic structure and public API.

## Files to Create

```
squire/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Public API exports
│   ├── squire.ts             # Main Squire class
│   ├── types.ts              # All type definitions
│   └── config.ts             # Configuration management
└── tests/
    └── squire.test.ts
```

## package.json

```json
{
  "name": "@discode/squire",
  "version": "0.1.0",
  "description": "Personal AI assistant with memory, skills, and scheduling",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "node --test dist/**/*.test.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "uuid": "^10.0.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0"
  },
  "peerDependencies": {
    "@anthropic-ai/sdk": "^0.30.0"
  }
}
```

## Core Types (types.ts)

```typescript
import type { Anthropic } from '@anthropic-ai/sdk';

// ============================================================================
// Squire Configuration
// ============================================================================

export interface SquireConfig {
  // Identification
  squireId: string;
  name: string;

  // Storage paths
  dataDir: string;           // ~/.squire/data by default
  memoryDbPath: string;      // SQLite database
  skillsDir: string;         // Skills storage

  // Model configuration
  model: string;             // claude-sonnet-4-20250514 default
  fallbackModel?: string;

  // Behavior
  daemonMode: boolean;       // Run as persistent daemon
  pollInterval: number;      // Scheduler poll interval (ms)

  // Memory
  memory: MemoryConfig;

  // Skills
  skills: SkillsConfig;

  // Permissions (simpler than DisCode)
  permissions: PermissionConfig;
}

export interface MemoryConfig {
  enabled: boolean;
  provider: 'local' | 'openai' | 'voyage';
  embeddingModel?: string;   // For local: embeddinggemma-300M
  retentionDays: number;
}

export interface SkillsConfig {
  bundled: string[];         // Built-in skills to load
  additional: string[];      // Extra skill directories
  autoInstall: boolean;      // Auto-install skill dependencies
}

export interface PermissionConfig {
  mode: 'trust' | 'confirm' | 'ask';
  // trust: No prompts, just do it
  // confirm: Prompt for risky operations only
  // ask: Prompt for everything
  allowedTools: string[];    // Tools that never prompt
  blockedTools: string[];    // Tools that always block
}

// ============================================================================
// Workspace
// ============================================================================

export interface Workspace {
  workspaceId: string;
  name: string;
  source: 'discord_channel' | 'discord_dm' | 'discode_thread' | 'cli';
  sourceId: string;          // Channel ID, DM ID, thread ID, etc.
  createdAt: string;
  lastActivityAt: string;
  status: 'active' | 'idle' | 'paused';
  context: WorkspaceContext;
}

export interface WorkspaceContext {
  projectPath?: string;      // Working directory if applicable
  currentTask?: string;      // What squire is working on
  recentFiles?: string[];    // Recently accessed files
  environment?: Record<string, string>;
}

// ============================================================================
// Memory
// ============================================================================

export interface MemoryEntry {
  id: string;
  content: string;
  source: 'user' | 'squire' | 'skill' | 'document';
  workspaceId?: string;      // Optional workspace association
  embedding?: number[];      // Vector embedding
  metadata: Record<string, any>;
  createdAt: string;
  expiresAt?: string;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

// ============================================================================
// Scheduled Tasks
// ============================================================================

export interface ScheduledTask {
  taskId: string;
  workspaceId: string;
  description: string;
  schedule: TaskSchedule;
  status: 'pending' | 'running' | 'completed' | 'failed';
  lastRunAt?: string;
  nextRunAt: string;
  createdAt: string;
  result?: TaskResult;
}

export interface TaskSchedule {
  type: 'once' | 'interval' | 'cron';
  // once: run once at specific time
  // interval: run every N seconds/minutes/hours
  // cron: cron expression
  value: string | number;
}

export interface TaskResult {
  success: boolean;
  output?: string;
  error?: string;
  completedAt: string;
}

// ============================================================================
// Skills
// ============================================================================

export interface Skill {
  name: string;
  description: string;
  path: string;
  frontmatter: SkillFrontmatter;
  content: string;           // The skill instructions
  eligible: boolean;         // Based on platform/env checks
  eligibilityReason?: string;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  version?: string;
  author?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  metadata?: {
    squire?: {
      emoji?: string;
      requires?: {
        bins?: string[];
        env?: string[];
      };
      install?: SkillInstallStep[];
    };
  };
}

export interface SkillInstallStep {
  type: 'brew' | 'npm' | 'go' | 'uv' | 'download';
  package: string;
  version?: string;
}

// ============================================================================
// Messages
// ============================================================================

export interface SquireMessage {
  role: 'user' | 'assistant';
  content: string;
  workspaceId: string;
  timestamp: string;
  metadata?: {
    toolCalls?: ToolCall[];
    toolResults?: ToolResult[];
    memories?: string[];      // Memory IDs referenced
  };
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, any>;
}

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

// ============================================================================
// Events
// ============================================================================

export type SquireEvent =
  | { type: 'workspace_created'; workspace: Workspace }
  | { type: 'workspace_activated'; workspaceId: string }
  | { type: 'memory_added'; entry: MemoryEntry }
  | { type: 'task_scheduled'; task: ScheduledTask }
  | { type: 'task_completed'; task: ScheduledTask }
  | { type: 'skill_loaded'; skill: Skill }
  | { type: 'message_received'; message: SquireMessage }
  | { type: 'message_sent'; message: SquireMessage };

export type SquireEventHandler = (event: SquireEvent) => void;
```

## Main Squire Class (squire.ts)

```typescript
import { EventEmitter } from 'events';
import type {
  SquireConfig,
  Workspace,
  MemoryEntry,
  ScheduledTask,
  Skill,
  SquireMessage,
  SquireEvent,
  SquireEventHandler
} from './types.js';

export class Squire extends EventEmitter {
  private config: SquireConfig;
  private workspaces: Map<string, Workspace> = new Map();
  private activeWorkspaceId: string | null = null;
  private memoryManager: MemoryManager | null = null;
  private skillManager: SkillManager | null = null;
  private scheduler: Scheduler | null = null;
  private running: boolean = false;

  constructor(config: Partial<SquireConfig> & { squireId: string }) {
    super();
    this.config = this.resolveConfig(config);
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async start(): Promise<void> {
    if (this.running) return;

    // Initialize memory system
    if (this.config.memory.enabled) {
      this.memoryManager = new MemoryManager(this.config.memory, this.config.dataDir);
      await this.memoryManager.initialize();
    }

    // Load skills
    this.skillManager = new SkillManager(this.config.skills, this.config.dataDir);
    await this.skillManager.loadSkills();

    // Start scheduler if daemon mode
    if (this.config.daemonMode) {
      this.scheduler = new Scheduler(this.config.pollInterval);
      await this.scheduler.start();
    }

    this.running = true;
    console.log(`[Squire] Started: ${this.config.name}`);
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    if (this.scheduler) {
      await this.scheduler.stop();
    }

    if (this.memoryManager) {
      await this.memoryManager.close();
    }

    this.running = false;
    console.log(`[Squire] Stopped: ${this.config.name}`);
  }

  // ==========================================================================
  // Workspace Management
  // ==========================================================================

  async createWorkspace(options: {
    name: string;
    source: Workspace['source'];
    sourceId: string;
    context?: Workspace['context'];
  }): Promise<Workspace> {
    const workspace: Workspace = {
      workspaceId: uuid(),
      name: options.name,
      source: options.source,
      sourceId: options.sourceId,
      createdAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
      status: 'active',
      context: options.context || {}
    };

    this.workspaces.set(workspace.workspaceId, workspace);
    this.emit({ type: 'workspace_created', workspace });

    return workspace;
  }

  getWorkspace(workspaceId: string): Workspace | undefined {
    return this.workspaces.get(workspaceId);
  }

  getWorkspaceBySource(sourceId: string): Workspace | undefined {
    for (const workspace of this.workspaces.values()) {
      if (workspace.sourceId === sourceId) {
        return workspace;
      }
    }
    return undefined;
  }

  setActiveWorkspace(workspaceId: string): void {
    this.activeWorkspaceId = workspaceId;
    this.emit({ type: 'workspace_activated', workspaceId });
  }

  // ==========================================================================
  // Messaging
  // ==========================================================================

  async sendMessage(workspaceId: string, content: string): Promise<SquireMessage> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    // Build context with memory
    const memories = await this.memoryManager?.search(content, 5) || [];

    // Build system prompt with skills
    const skillPrompts = this.skillManager?.getEligibleSkills()
      .map(s => s.content)
      .join('\n\n') || '';

    // TODO: Call Anthropic API
    // TODO: Process tool calls
    // TODO: Store in memory if needed

    const message: SquireMessage = {
      role: 'assistant',
      content: 'TODO: implement',
      workspaceId,
      timestamp: new Date().toISOString()
    };

    this.emit({ type: 'message_sent', message });
    return message;
  }

  // ==========================================================================
  // Memory
  // ==========================================================================

  async remember(content: string, options?: {
    source?: MemoryEntry['source'];
    workspaceId?: string;
    metadata?: Record<string, any>;
  }): Promise<MemoryEntry> {
    if (!this.memoryManager) {
      throw new Error('Memory system not enabled');
    }

    const entry = await this.memoryManager.add(content, options);
    this.emit({ type: 'memory_added', entry });
    return entry;
  }

  async recall(query: string, limit?: number): Promise<MemorySearchResult[]> {
    if (!this.memoryManager) {
      throw new Error('Memory system not enabled');
    }

    return this.memoryManager.search(query, limit || 10);
  }

  // ==========================================================================
  // Scheduling
  // ==========================================================================

  async scheduleTask(options: {
    workspaceId: string;
    description: string;
    schedule: ScheduledTask['schedule'];
  }): Promise<ScheduledTask> {
    if (!this.scheduler) {
      throw new Error('Scheduler not enabled (daemon mode required)');
    }

    const task = await this.scheduler.schedule(options);
    this.emit({ type: 'task_scheduled', task });
    return task;
  }

  // ==========================================================================
  // Skills
  // ==========================================================================

  getSkills(): Skill[] {
    return this.skillManager?.getEligibleSkills() || [];
  }

  // ==========================================================================
  // Configuration
  // ==========================================================================

  private resolveConfig(partial: Partial<SquireConfig> & { squireId: string }): SquireConfig {
    const dataDir = partial.dataDir || path.join(os.homedir(), '.squire', 'data');

    return {
      squireId: partial.squireId,
      name: partial.name || 'Squire',
      dataDir,
      memoryDbPath: partial.memoryDbPath || path.join(dataDir, 'memory.db'),
      skillsDir: partial.skillsDir || path.join(dataDir, 'skills'),
      model: partial.model || 'claude-sonnet-4-20250514',
      fallbackModel: partial.fallbackModel,
      daemonMode: partial.daemonMode ?? false,
      pollInterval: partial.pollInterval || 60000,
      memory: {
        enabled: partial.memory?.enabled ?? true,
        provider: partial.memory?.provider || 'local',
        embeddingModel: partial.memory?.embeddingModel,
        retentionDays: partial.memory?.retentionDays || 90,
        ...partial.memory
      },
      skills: {
        bundled: partial.skills?.bundled || ['browser', 'memory', 'web'],
        additional: partial.skills?.additional || [],
        autoInstall: partial.skills?.autoInstall ?? true,
        ...partial.skills
      },
      permissions: {
        mode: partial.permissions?.mode || 'confirm',
        allowedTools: partial.permissions?.allowedTools || [],
        blockedTools: partial.permissions?.blockedTools || [],
        ...partial.permissions
      }
    };
  }
}
```

## Public API (index.ts)

```typescript
// Main class
export { Squire } from './squire.js';

// Types
export type {
  SquireConfig,
  MemoryConfig,
  SkillsConfig,
  PermissionConfig,
  Workspace,
  WorkspaceContext,
  MemoryEntry,
  MemorySearchResult,
  ScheduledTask,
  TaskSchedule,
  TaskResult,
  Skill,
  SkillFrontmatter,
  SkillInstallStep,
  SquireMessage,
  ToolCall,
  ToolResult,
  SquireEvent,
  SquireEventHandler
} from './types.js';

// Subsystems (for advanced use)
export { MemoryManager } from './memory/manager.js';
export { SkillManager } from './skills/manager.js';
export { Scheduler } from './scheduler/scheduler.js';
export { WorkspaceManager } from './workspace.js';
```

## Default Config Location

```
~/.squire/
├── config.json         # User configuration
├── data/
│   ├── memory.db       # SQLite database
│   ├── models/         # Downloaded embedding models
│   └── skills/         # Installed skills
└── logs/
    └── squire.log
```

## Testing Strategy

```typescript
// tests/squire.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { Squire } from '../dist/index.js';

test('Squire creates workspace', async () => {
  const squire = new Squire({ squireId: 'test-squire' });
  await squire.start();

  const workspace = await squire.createWorkspace({
    name: 'Test Workspace',
    source: 'cli',
    sourceId: 'test-1'
  });

  assert.ok(workspace.workspaceId);
  assert.strictEqual(workspace.name, 'Test Workspace');

  await squire.stop();
});

test('Squire stores and retrieves memories', async () => {
  const squire = new Squire({
    squireId: 'test-squire-memory',
    memory: { enabled: true, provider: 'local' }
  });
  await squire.start();

  await squire.remember('I prefer TypeScript over JavaScript', {
    source: 'user'
  });

  const results = await squire.recall('programming preferences');
  assert.ok(results.length > 0);

  await squire.stop();
});
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `better-sqlite3` | Memory storage, scheduler persistence |
| `uuid` | Generate unique IDs |
| `@anthropic-ai/sdk` | LLM calls (peer dependency) |

## Next Phase

After this foundation is in place:
- **Phase 2**: Implement MemoryManager with local embeddings
- **Phase 3**: Implement SkillManager with frontmatter parsing
- **Phase 4**: Implement Scheduler for daemon mode
