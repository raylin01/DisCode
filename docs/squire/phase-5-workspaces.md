# Phase 5: Workspaces

**Goal:** Implement workspace management for channel-isolated contexts with shared global memory.

## Overview

Workspaces provide:
- **Isolation** - Each Discord channel/thread has its own workspace
- **Shared memory** - Global memory accessible across all workspaces
- **Independent context** - Each workspace maintains its own conversation state
- **Source tracking** - Know where each workspace came from

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    WORKSPACE MANAGER                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    GLOBAL MEMORY                             ││
│  │              (Shared across all workspaces)                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                              │                                   │
│         ┌────────────────────┼────────────────────┐             │
│         │                    │                    │             │
│         ▼                    ▼                    ▼             │
│  ┌─────────────┐      ┌─────────────┐      ┌─────────────┐      │
│  │  Workspace  │      │  Workspace  │      │  Workspace  │      │
│  │  #general   │      │   DM User   │      │ #project-x  │      │
│  │             │      │             │      │             │      │
│  │ - Context   │      │ - Context   │      │ - Context   │      │
│  │ - History   │      │ - History   │      │ - History   │      │
│  │ - Status    │      │ - Status    │      │ - Status    │      │
│  └─────────────┘      └─────────────┘      └─────────────┘      │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Files to Create/Modify

```
squire/src/
├── workspace.ts            # WorkspaceManager class
├── types.ts                # Add workspace types (already in phase 1)
└── squire.ts               # Integrate workspace management
```

## Workspace Manager (workspace.ts)

```typescript
import Database from 'better-sqlite3';
import crypto from 'crypto';
import path from 'path';
import type { Workspace, WorkspaceContext, SquireMessage } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL UNIQUE,
  context_json JSON,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_workspaces_source ON workspaces(source, source_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_status ON workspaces(status);

CREATE TABLE IF NOT EXISTS workspace_messages (
  message_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TIMESTAMP NOT NULL,
  metadata_json JSON
);

CREATE INDEX IF NOT EXISTS idx_messages_workspace ON workspace_messages(workspace_id, timestamp);
`;

export interface CreateWorkspaceOptions {
  name: string;
  source: Workspace['source'];
  sourceId: string;
  context?: WorkspaceContext;
}

export interface WorkspaceWithHistory extends Workspace {
  recentMessages: SquireMessage[];
}

export class WorkspaceManager {
  private db: Database.Database;
  private cache: Map<string, Workspace> = new Map();
  private messageHistoryLimit: number;

  constructor(dbPath: string, messageHistoryLimit: number = 50) {
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
    this.messageHistoryLimit = messageHistoryLimit;
    this.loadCache();
  }

  private loadCache(): void {
    const rows = this.db.prepare(`
      SELECT * FROM workspaces WHERE status != 'deleted'
    `).all() as any[];

    for (const row of rows) {
      const workspace = this.rowToWorkspace(row);
      this.cache.set(workspace.workspaceId, workspace);
      this.cache.set(`source:${workspace.source}:${workspace.sourceId}`, workspace);
    }

    console.log(`[Workspaces] Loaded ${this.cache.size / 2} workspaces`);
  }

  create(options: CreateWorkspaceOptions): Workspace {
    // Check if workspace for this source already exists
    const existing = this.getBySource(options.source, options.sourceId);
    if (existing) {
      // Reactivate if paused
      if (existing.status === 'paused') {
        this.updateStatus(existing.workspaceId, 'active');
        existing.status = 'active';
      }
      return existing;
    }

    const workspaceId = crypto.randomUUID();
    const now = new Date().toISOString();

    const workspace: Workspace = {
      workspaceId,
      name: options.name,
      source: options.source,
      sourceId: options.sourceId,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      context: options.context || {}
    };

    this.db.prepare(`
      INSERT INTO workspaces (workspace_id, name, source, source_id, context_json, status, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      workspaceId,
      workspace.name,
      workspace.source,
      workspace.sourceId,
      JSON.stringify(workspace.context),
      workspace.status,
      workspace.createdAt,
      workspace.lastActivityAt
    );

    this.cache.set(workspaceId, workspace);
    this.cache.set(`source:${workspace.source}:${workspace.sourceId}`, workspace);

    console.log(`[Workspaces] Created: ${workspace.name} (${workspace.source}:${workspace.sourceId})`);

    return workspace;
  }

  get(workspaceId: string): Workspace | undefined {
    return this.cache.get(workspaceId);
  }

  getBySource(source: Workspace['source'], sourceId: string): Workspace | undefined {
    return this.cache.get(`source:${source}:${sourceId}`);
  }

  getAll(): Workspace[] {
    const workspaces: Workspace[] = [];
    for (const [key, workspace] of this.cache) {
      if (!key.startsWith('source:')) {
        workspaces.push(workspace);
      }
    }
    return workspaces;
  }

  getActive(): Workspace[] {
    return this.getAll().filter(w => w.status === 'active');
  }

  updateContext(workspaceId: string, context: Partial<WorkspaceContext>): void {
    const workspace = this.cache.get(workspaceId);
    if (!workspace) return;

    workspace.context = { ...workspace.context, ...context };
    workspace.lastActivityAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE workspaces SET context_json = ?, last_activity_at = ? WHERE workspace_id = ?
    `).run(JSON.stringify(workspace.context), workspace.lastActivityAt, workspaceId);
  }

  updateStatus(workspaceId: string, status: Workspace['status']): void {
    const workspace = this.cache.get(workspaceId);
    if (!workspace) return;

    workspace.status = status;
    workspace.lastActivityAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE workspaces SET status = ?, last_activity_at = ? WHERE workspace_id = ?
    `).run(status, workspace.lastActivityAt, workspaceId);
  }

  recordActivity(workspaceId: string): void {
    const workspace = this.cache.get(workspaceId);
    if (!workspace) return;

    workspace.lastActivityAt = new Date().toISOString();

    this.db.prepare(`
      UPDATE workspaces SET last_activity_at = ? WHERE workspace_id = ?
    `).run(workspace.lastActivityAt, workspaceId);
  }

  delete(workspaceId: string): boolean {
    const workspace = this.cache.get(workspaceId);
    if (!workspace) return false;

    // Soft delete
    this.updateStatus(workspaceId, 'deleted');

    this.cache.delete(workspaceId);
    this.cache.delete(`source:${workspace.source}:${workspace.sourceId}`);

    return true;
  }

  // Message history
  addMessage(workspaceId: string, message: SquireMessage): void {
    this.db.prepare(`
      INSERT INTO workspace_messages (message_id, workspace_id, role, content, timestamp, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(),
      workspaceId,
      message.role,
      message.content,
      message.timestamp,
      JSON.stringify(message.metadata || {})
    );

    this.recordActivity(workspaceId);

    // Clean up old messages
    this.pruneMessages(workspaceId);
  }

  getMessages(workspaceId: string, limit?: number): SquireMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM workspace_messages
      WHERE workspace_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `).all(workspaceId, limit || this.messageHistoryLimit) as any[];

    return rows.reverse().map(row => ({
      role: row.role,
      content: row.content,
      workspaceId: row.workspace_id,
      timestamp: row.timestamp,
      metadata: JSON.parse(row.metadata_json || '{}')
    }));
  }

  getWorkspaceWithHistory(workspaceId: string, messageLimit?: number): WorkspaceWithHistory | null {
    const workspace = this.cache.get(workspaceId);
    if (!workspace) return null;

    return {
      ...workspace,
      recentMessages: this.getMessages(workspaceId, messageLimit)
    };
  }

  private pruneMessages(workspaceId: string): void {
    const count = this.db.prepare(`
      SELECT COUNT(*) as count FROM workspace_messages WHERE workspace_id = ?
    `).get(workspaceId) as any;

    if (count.count > this.messageHistoryLimit * 1.5) {
      // Delete oldest messages beyond limit
      this.db.prepare(`
        DELETE FROM workspace_messages
        WHERE workspace_id = ? AND message_id IN (
          SELECT message_id FROM workspace_messages
          WHERE workspace_id = ?
          ORDER BY timestamp ASC
          LIMIT ?
        )
      `).run(
        workspaceId,
        workspaceId,
        count.count - this.messageHistoryLimit
      );
    }
  }

  private rowToWorkspace(row: any): Workspace {
    return {
      workspaceId: row.workspace_id,
      name: row.name,
      source: row.source,
      sourceId: row.source_id,
      context: JSON.parse(row.context_json || '{}'),
      status: row.status,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at
    };
  }

  close(): void {
    this.db.close();
  }
}
```

## Source Adapters

Different sources (Discord channels, DMs, DisCode threads) have different characteristics:

```typescript
// squire/src/sources/types.ts

import type { Workspace } from '../types.js';

export interface SourceAdapter {
  type: Workspace['source'];

  // Create a workspace for this source
  createWorkspace(sourceId: string, options?: any): Promise<Workspace>;

  // Send a message to this source
  sendMessage(workspaceId: string, content: string): Promise<void>;

  // Get display name for this source
  getDisplayName(sourceId: string): Promise<string>;

  // Check if source still exists
  isSourceValid(sourceId: string): Promise<boolean>;
}

// squire/src/sources/discord-channel.ts

import type { SourceAdapter, Workspace } from './types.js';
import type { WorkspaceManager } from '../workspace.js';
import type { Client, TextChannel } from 'discord.js';

export class DiscordChannelAdapter implements SourceAdapter {
  type = 'discord_channel' as const;

  constructor(
    private client: Client,
    private workspaceManager: WorkspaceManager
  ) {}

  async createWorkspace(channelId: string, options?: { name?: string }): Promise<Workspace> {
    const channel = await this.client.channels.fetch(channelId) as TextChannel;

    return this.workspaceManager.create({
      name: options?.name || channel.name,
      source: 'discord_channel',
      sourceId: channelId,
      context: {
        projectPath: undefined,
        environment: {}
      }
    });
  }

  async sendMessage(workspaceId: string, content: string): Promise<void> {
    const workspace = this.workspaceManager.get(workspaceId);
    if (!workspace || workspace.source !== 'discord_channel') {
      throw new Error('Invalid workspace for Discord channel');
    }

    const channel = await this.client.channels.fetch(workspace.sourceId) as TextChannel;
    await channel.send(content);
  }

  async getDisplayName(channelId: string): Promise<string> {
    const channel = await this.client.channels.fetch(channelId) as TextChannel;
    return `#${channel.name}`;
  }

  async isSourceValid(channelId: string): Promise<boolean> {
    try {
      const channel = await this.client.channels.fetch(channelId);
      return channel !== null;
    } catch {
      return false;
    }
  }
}

// squire/src/sources/discord-dm.ts

import type { SourceAdapter, Workspace } from './types.js';
import type { WorkspaceManager } from '../workspace.js';
import type { Client, User } from 'discord.js';

export class DiscordDMAdapter implements SourceAdapter {
  type = 'discord_dm' as const;

  constructor(
    private client: Client,
    private workspaceManager: WorkspaceManager
  ) {}

  async createWorkspace(userId: string, options?: { name?: string }): Promise<Workspace> {
    const user = await this.client.users.fetch(userId);

    return this.workspaceManager.create({
      name: options?.name || `DM: ${user.username}`,
      source: 'discord_dm',
      sourceId: userId,
      context: {}
    });
  }

  async sendMessage(workspaceId: string, content: string): Promise<void> {
    const workspace = this.workspaceManager.get(workspaceId);
    if (!workspace || workspace.source !== 'discord_dm') {
      throw new Error('Invalid workspace for Discord DM');
    }

    const user = await this.client.users.fetch(workspace.sourceId);
    const dm = await user.createDM();
    await dm.send(content);
  }

  async getDisplayName(userId: string): Promise<string> {
    const user = await this.client.users.fetch(userId);
    return `DM with ${user.username}`;
  }

  async isSourceValid(userId: string): Promise<boolean> {
    try {
      const user = await this.client.users.fetch(userId);
      return user !== null;
    } catch {
      return false;
    }
  }
}
```

## Integration with Squire

```typescript
// In squire.ts

export class Squire extends EventEmitter {
  // ... existing code ...

  private workspaceManager: WorkspaceManager;

  async start(): Promise<void> {
    // ... existing initialization ...

    // Initialize workspace manager
    const workspaceDbPath = path.join(this.config.dataDir, 'workspaces.db');
    this.workspaceManager = new WorkspaceManager(workspaceDbPath);

    // ... rest of initialization ...
  }

  // Workspace management
  createWorkspace(options: CreateWorkspaceOptions): Workspace {
    const workspace = this.workspaceManager.create(options);
    this.emit({ type: 'workspace_created', workspace });
    return workspace;
  }

  getWorkspace(workspaceId: string): Workspace | undefined {
    return this.workspaceManager.get(workspaceId);
  }

  getWorkspaceBySource(source: Workspace['source'], sourceId: string): Workspace | undefined {
    return this.workspaceManager.getBySource(source, sourceId);
  }

  // Message handling with workspace context
  async sendMessage(workspaceId: string, content: string): Promise<SquireMessage> {
    const workspace = this.workspaceManager.get(workspaceId);
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    // Get message history for context
    const history = this.workspaceManager.getMessages(workspaceId, 20);

    // Search global memory for relevant context
    const memories = await this.memoryManager?.search(content, 5) || [];

    // Build context
    const systemPrompt = this.buildSystemPrompt(workspace, memories);

    // Call LLM with history and context
    const response = await this.callLLM(systemPrompt, history, content);

    // Record message
    const message: SquireMessage = {
      role: 'assistant',
      content: response,
      workspaceId,
      timestamp: new Date().toISOString()
    };

    this.workspaceManager.addMessage(workspaceId, message);
    this.emit({ type: 'message_sent', message });

    return message;
  }

  private buildSystemPrompt(workspace: Workspace, memories: MemorySearchResult[]): string {
    const parts: string[] = [];

    // Base identity
    parts.push(`You are ${this.config.name}, a personal AI assistant.`);
    parts.push('');

    // Workspace context
    parts.push(`## Current Workspace`);
    parts.push(`- Name: ${workspace.name}`);
    parts.push(`- Source: ${workspace.source}`);

    if (workspace.context.projectPath) {
      parts.push(`- Working directory: ${workspace.context.projectPath}`);
    }

    if (workspace.context.currentTask) {
      parts.push(`- Current task: ${workspace.context.currentTask}`);
    }

    parts.push('');

    // Relevant memories
    if (memories.length > 0) {
      parts.push(`## Relevant Memories`);
      for (const memory of memories) {
        parts.push(`- ${memory.entry.content}`);
      }
      parts.push('');
    }

    // Skills
    const skillPrompt = this.skillManager?.buildSystemPrompt() || '';
    if (skillPrompt) {
      parts.push(skillPrompt);
    }

    return parts.join('\n');
  }
}
```

## Workspace Tools for Agent

```typescript
// squire/src/mcp/workspace-tools.ts

export const workspaceTools = [
  {
    name: 'workspace_set_task',
    description: 'Set the current task for this workspace',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Description of current task' }
      },
      required: ['task']
    }
  },
  {
    name: 'workspace_set_project',
    description: 'Set the working directory for this workspace',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Project directory path' }
      },
      required: ['path']
    }
  },
  {
    name: 'workspace_status',
    description: 'Get the current workspace status',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  }
];
```

## Testing

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { WorkspaceManager } from '../dist/workspace.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

test('Creates and retrieves workspaces', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-'));
  const manager = new WorkspaceManager(path.join(tempDir, 'workspaces.db'));

  const workspace = manager.create({
    name: 'Test Channel',
    source: 'discord_channel',
    sourceId: 'channel-123'
  });

  assert.ok(workspace.workspaceId);
  assert.strictEqual(workspace.name, 'Test Channel');

  const retrieved = manager.get(workspace.workspaceId);
  assert.strictEqual(retrieved?.workspaceId, workspace.workspaceId);

  manager.close();
});

test('Prevents duplicate workspaces for same source', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-'));
  const manager = new WorkspaceManager(path.join(tempDir, 'workspaces.db'));

  const ws1 = manager.create({
    name: 'First',
    source: 'discord_channel',
    sourceId: 'channel-456'
  });

  const ws2 = manager.create({
    name: 'Second',
    source: 'discord_channel',
    sourceId: 'channel-456'
  });

  // Should return same workspace
  assert.strictEqual(ws1.workspaceId, ws2.workspaceId);

  manager.close();
});

test('Records and retrieves messages', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'squire-test-'));
  const manager = new WorkspaceManager(path.join(tempDir, 'workspaces.db'));

  const workspace = manager.create({
    name: 'Message Test',
    source: 'discord_dm',
    sourceId: 'user-789'
  });

  manager.addMessage(workspace.workspaceId, {
    role: 'user',
    content: 'Hello!',
    workspaceId: workspace.workspaceId,
    timestamp: new Date().toISOString()
  });

  manager.addMessage(workspace.workspaceId, {
    role: 'assistant',
    content: 'Hi there!',
    workspaceId: workspace.workspaceId,
    timestamp: new Date().toISOString()
  });

  const messages = manager.getMessages(workspace.workspaceId);
  assert.strictEqual(messages.length, 2);
  assert.strictEqual(messages[0].content, 'Hello!');

  manager.close();
});
```

## Next Phase

- **Phase 6**: SquireBot - Standalone Discord bot
