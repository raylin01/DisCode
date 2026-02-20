# Phase 8: Discussion Board / Ticket Tracker

**Goal:** Create a Discord forum-based ticket tracker for bugs, feature requests, and AI-user discussions.

## Overview

The Discussion Board uses Discord's Forum Channels to create a ticket tracking system where:
- Users can file bug reports and feature requests
- AI agents can ask clarifying questions on tickets
- AI can pick up tickets to work on
- Progress and status are tracked via forum tags

```
┌─────────────────────────────────────────────────────────────────┐
│                    DISCUSSION BOARD SYSTEM                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              DISCORD FORUM CHANNEL                           ││
│  │                                                              ││
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐         ││
│  │  │ 🐛 Bug       │ │ ✨ Feature   │ │ ❓ Question  │         ││
│  │  │ Report Post  │ │ Request Post │ │ Post         │         ││
│  │  │              │ │              │ │              │         ││
│  │  │ Status: Open │ │ Status: In   │ │ Status:      │         ││
│  │  │ Priority:    │ │ Progress     │ │ Answered     │         ││
│  │  │ High         │ │ Assignee:AI  │ │              │         ││
│  │  └──────────────┘ └──────────────┘ └──────────────┘         ││
│  │                                                              ││
│  │  Tags: [Bug] [Feature] [Question] [Priority:High/Normal/Low]││
│  │        [Status:Open/In-Progress/Blocked/Done/WontFix]        ││
│  │        [Assignee:AI/User]                                    ││
│  └─────────────────────────────────────────────────────────────┘│
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    TICKET MANAGER                            ││
│  │  - Creates forum posts from user/AI requests                 ││
│  │  - Updates tags based on status changes                      ││
│  │  - Assigns tickets to AI or users                            ││
│  │  - Tracks ticket history in SQLite                           ││
│  └─────────────────────────────────────────────────────────────┘│
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                       SQUIRE                                 ││
│  │  - Watches forum for new posts                               ││
│  │  - AI can pick up tickets                                    ││
│  │  - Posts updates and questions                               ││
│  │  - Uses memory to recall related tickets                     ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Architecture Options

### Option A: Separate SquireTicketBot (Recommended for standalone)

```
┌─────────────────┐     ┌─────────────────┐
│  Discord Guild  │     │  SquireTicket   │
│  Forum Channel  │◄───►│     Bot         │
│                 │     │  (separate)     │
└─────────────────┘     └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │    Squire       │
                        │    Package      │
                        └─────────────────┘
```

**Pros:**
- Simple deployment - just ticket tracking, no session management
- Can be used by teams without DisCode
- Independent scaling and maintenance
- Single bot token, simple permissions

**Cons:**
- Separate codebase to maintain
- No integration with AI sessions

### Option B: Integrated into DisCode Bot (Recommended for DisCode users)

```
┌─────────────────┐     ┌─────────────────────────────────────────┐
│  Discord Guild  │     │            DISCODE BOT                   │
│  Forum Channel  │◄───►│  ┌─────────────┐ ┌─────────────────┐    │
│                 │     │  │ Session     │ │ Ticket          │    │
└─────────────────┘     │  │ Management  │ │ Manager         │    │
                        │  └─────────────┘ └─────────────────┘    │
                        │         │                │               │
                        │         ▼                ▼               │
                        │  ┌─────────────────────────────────┐    │
                        │  │      RUNNER-AGENT (via WS)      │    │
                        │  │  ┌─────────────────────────┐    │    │
                        │  │  │  Squire Plugin          │    │    │
                        │  │  │  - Ticket Tools         │    │    │
                        │  │  │  - Memory               │    │    │
                        │  │  └─────────────────────────┘    │    │
                        │  └─────────────────────────────────┘    │
                        └─────────────────────────────────────────┘
```

**Pros:**
- Unified bot for sessions + tickets
- AI can work on tickets during sessions
- Shared memory between sessions and tickets
- Existing infrastructure

**Cons:**
- More complex permissions
- Heavier bot

### Recommendation: HYBRID APPROACH

Build the ticket tracker as part of the Squire package (`@discode/squire`), with two deployment options:

1. **SquireTicketBot** - Standalone for teams who just want ticket tracking
2. **DisCode Integration** - For teams already using DisCode

This follows the same pattern as the existing Squire architecture.

## Project Structure

```
squire/
├── src/
│   ├── tickets/                    # NEW
│   │   ├── index.ts               # Public API
│   │   ├── ticket-manager.ts      # Core ticket operations
│   │   ├── forum-bridge.ts        # Discord forum integration
│   │   ├── types.ts               # Ticket types
│   │   └── prompts.ts             # AI prompts for ticket handling
│   └── ...

squire-bot/                         # Standalone bot
├── src/
│   ├── commands/
│   │   └── ticket.ts              # /ticket command
│   └── handlers/
│       └── forum-watcher.ts       # Watch forum for new posts
```

## Core Types (tickets/types.ts)

```typescript
// ============================================================================
// Ticket Types
// ============================================================================

export type TicketType = 'bug' | 'feature' | 'question' | 'task';

export type TicketStatus =
  | 'open'
  | 'triage'
  | 'in_progress'
  | 'blocked'
  | 'review'
  | 'done'
  | 'wontfix'
  | 'duplicate';

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';

export type TicketAssignee = 'unassigned' | 'ai' | 'user';

export interface Ticket {
  ticketId: string;              // Internal ID
  forumPostId: string;           // Discord thread ID
  forumChannelId: string;        // Discord forum channel ID
  guildId: string;

  // Classification
  type: TicketType;
  status: TicketStatus;
  priority: TicketPriority;

  // Assignment
  assignee: TicketAssignee;
  assigneeUserId?: string;       // If assigned to specific user

  // Content
  title: string;
  description: string;

  // Metadata
  createdBy: 'user' | 'ai';
  createdById: string;           // User ID or AI instance ID
  createdAt: string;
  updatedAt: string;

  // Tracking
  relatedSessionIds: string[];   // Sessions that worked on this
  linkedCommitShas: string[];
  linkedPrUrls: string[];

  // AI context
  aiContext?: {
    lastAnalysis?: string;
    suggestedApproach?: string;
    estimatedComplexity?: 'trivial' | 'simple' | 'moderate' | 'complex';
  };
}

export interface TicketComment {
  commentId: string;
  ticketId: string;
  discordMessageId: string;

  author: 'user' | 'ai';
  authorId: string;

  content: string;
  createdAt: string;

  isAiQuestion?: boolean;        // AI asking clarifying question
  isStatusUpdate?: boolean;      // Status change notification
}

export interface TicketEvent {
  type: 'created' | 'updated' | 'commented' | 'status_changed' |
        'assigned' | 'unassigned' | 'closed' | 'reopened';
  ticket: Ticket;
  actor: 'user' | 'ai' | 'system';
  actorId: string;
  timestamp: string;
  details?: Record<string, any>;
}

// ============================================================================
// Forum Tag Configuration
// ============================================================================

export interface ForumTagConfig {
  // Type tags (mutually exclusive)
  bugTagId: string;
  featureTagId: string;
  questionTagId: string;
  taskTagId: string;

  // Status tags (mutually exclusive)
  statusTags: {
    open: string;
    triage: string;
    in_progress: string;
    blocked: string;
    review: string;
    done: string;
    wontfix: string;
    duplicate: string;
  };

  // Priority tags (mutually exclusive)
  priorityTags: {
    low: string;
    normal: string;
    high: string;
    urgent: string;
  };

  // Assignee tags (mutually exclusive)
  assigneeTags: {
    unassigned: string;
    ai: string;
    user: string;
  };
}
```

## Ticket Manager (tickets/ticket-manager.ts)

```typescript
import { EventEmitter } from 'events';
import Database from 'better-sqlite3';
import type { Ticket, TicketComment, TicketEvent, ForumTagConfig } from './types.js';

export class TicketManager extends EventEmitter {
  private db: Database.Database;
  private tagConfigs: Map<string, ForumTagConfig> = new Map();

  constructor(dataDir: string) {
    super();
    this.db = new Database(path.join(dataDir, 'tickets.db'));
    this.initDatabase();
  }

  private initDatabase(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tickets (
        ticket_id TEXT PRIMARY KEY,
        forum_post_id TEXT UNIQUE NOT NULL,
        forum_channel_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        priority TEXT NOT NULL DEFAULT 'normal',
        assignee TEXT NOT NULL DEFAULT 'unassigned',
        assignee_user_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        created_by_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        related_session_ids TEXT DEFAULT '[]',
        linked_commit_shas TEXT DEFAULT '[]',
        linked_pr_urls TEXT DEFAULT '[]',
        ai_context TEXT
      );

      CREATE TABLE IF NOT EXISTS ticket_comments (
        comment_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        discord_message_id TEXT NOT NULL,
        author TEXT NOT NULL,
        author_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        is_ai_question INTEGER DEFAULT 0,
        is_status_update INTEGER DEFAULT 0,
        FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
      );

      CREATE TABLE IF NOT EXISTS ticket_events (
        event_id TEXT PRIMARY KEY,
        ticket_id TEXT NOT NULL,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        details TEXT,
        FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
      );

      CREATE TABLE IF NOT EXISTS forum_tag_configs (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        config_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
      CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(assignee);
      CREATE INDEX IF NOT EXISTS idx_tickets_type ON tickets(type);
    `);
  }

  // ==========================================================================
  // Ticket CRUD
  // ==========================================================================

  async createTicket(options: {
    forumPostId: string;
    forumChannelId: string;
    guildId: string;
    type: Ticket['type'];
    title: string;
    description: string;
    createdBy: Ticket['createdBy'];
    createdById: string;
    priority?: Ticket['priority'];
  }): Promise<Ticket> {
    const ticketId = uuid();
    const now = new Date().toISOString();

    const ticket: Ticket = {
      ticketId,
      forumPostId: options.forumPostId,
      forumChannelId: options.forumChannelId,
      guildId: options.guildId,
      type: options.type,
      status: 'open',
      priority: options.priority || 'normal',
      assignee: 'unassigned',
      title: options.title,
      description: options.description,
      createdBy: options.createdBy,
      createdById: options.createdById,
      createdAt: now,
      updatedAt: now,
      relatedSessionIds: [],
      linkedCommitShas: [],
      linkedPrUrls: []
    };

    this.db.prepare(`
      INSERT INTO tickets (
        ticket_id, forum_post_id, forum_channel_id, guild_id,
        type, status, priority, assignee, title, description,
        created_by, created_by_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      ticket.ticketId, ticket.forumPostId, ticket.forumChannelId, ticket.guildId,
      ticket.type, ticket.status, ticket.priority, ticket.assignee,
      ticket.title, ticket.description,
      ticket.createdBy, ticket.createdById, ticket.createdAt, ticket.updatedAt
    );

    this.recordEvent(ticket, 'created', options.createdBy, options.createdById);
    this.emit('ticket_created', ticket);

    return ticket;
  }

  getTicket(ticketId: string): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE ticket_id = ?').get(ticketId);
    return row ? this.rowToTicket(row) : undefined;
  }

  getTicketByPostId(forumPostId: string): Ticket | undefined {
    const row = this.db.prepare('SELECT * FROM tickets WHERE forum_post_id = ?').get(forumPostId);
    return row ? this.rowToTicket(row) : undefined;
  }

  async updateTicket(ticketId: string, updates: Partial<Ticket>): Promise<Ticket> {
    const ticket = this.getTicket(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);

    const updatedTicket = { ...ticket, ...updates, updatedAt: new Date().toISOString() };

    this.db.prepare(`
      UPDATE tickets SET
        status = ?, priority = ?, assignee = ?, assignee_user_id = ?,
        title = ?, description = ?, updated_at = ?, ai_context = ?
      WHERE ticket_id = ?
    `).run(
      updatedTicket.status, updatedTicket.priority, updatedTicket.assignee,
      updatedTicket.assigneeUserId || null, updatedTicket.title, updatedTicket.description,
      updatedTicket.updatedAt, JSON.stringify(updatedTicket.aiContext || {}),
      ticketId
    );

    return updatedTicket;
  }

  // ==========================================================================
  // Status Management
  // ==========================================================================

  async setTicketStatus(
    ticketId: string,
    status: Ticket['status'],
    actor: 'user' | 'ai' | 'system',
    actorId: string
  ): Promise<Ticket> {
    const oldTicket = this.getTicket(ticketId);
    if (!oldTicket) throw new Error(`Ticket not found: ${ticketId}`);

    const ticket = await this.updateTicket(ticketId, { status });

    this.recordEvent(ticket, 'status_changed', actor, actorId, {
      oldStatus: oldTicket.status,
      newStatus: status
    });

    this.emit('ticket_status_changed', { ticket, oldStatus: oldTicket.status });

    return ticket;
  }

  // ==========================================================================
  // Assignment
  // ==========================================================================

  async assignTicket(
    ticketId: string,
    assignee: Ticket['assignee'],
    assigneeUserId: string | undefined,
    actor: 'user' | 'ai' | 'system',
    actorId: string
  ): Promise<Ticket> {
    const ticket = await this.updateTicket(ticketId, { assignee, assigneeUserId });

    this.recordEvent(ticket, 'assigned', actor, actorId, { assignee, assigneeUserId });
    this.emit('ticket_assigned', ticket);

    return ticket;
  }

  async assignToSelf(ticketId: string, aiInstanceId: string): Promise<Ticket> {
    return this.assignTicket(ticketId, 'ai', aiInstanceId, 'ai', aiInstanceId);
  }

  // ==========================================================================
  // Queries
  // ==========================================================================

  getOpenTickets(guildId?: string): Ticket[] {
    const sql = guildId
      ? 'SELECT * FROM tickets WHERE guild_id = ? AND status NOT IN (?, ?)'
      : 'SELECT * FROM tickets WHERE status NOT IN (?, ?)';

    const params = guildId
      ? [guildId, 'done', 'wontfix']
      : ['done', 'wontfix'];

    return this.db.prepare(sql).all(...params).map(this.rowToTicket);
  }

  getTicketsAssignedToAI(): Ticket[] {
    return this.db.prepare('SELECT * FROM tickets WHERE assignee = ? AND status != ?')
      .all('ai', 'done')
      .map(this.rowToTicket);
  }

  getTicketsByType(type: Ticket['type'], guildId?: string): Ticket[] {
    const sql = guildId
      ? 'SELECT * FROM tickets WHERE type = ? AND guild_id = ?'
      : 'SELECT * FROM tickets WHERE type = ?';
    const params = guildId ? [type, guildId] : [type];

    return this.db.prepare(sql).all(...params).map(this.rowToTicket);
  }

  // ==========================================================================
  // Comments
  // ==========================================================================

  async addComment(options: {
    ticketId: string;
    discordMessageId: string;
    author: 'user' | 'ai';
    authorId: string;
    content: string;
    isAiQuestion?: boolean;
  }): Promise<TicketComment> {
    const commentId = uuid();
    const now = new Date().toISOString();

    const comment: TicketComment = {
      commentId,
      ticketId: options.ticketId,
      discordMessageId: options.discordMessageId,
      author: options.author,
      authorId: options.authorId,
      content: options.content,
      createdAt: now,
      isAiQuestion: options.isAiQuestion || false
    };

    this.db.prepare(`
      INSERT INTO ticket_comments (
        comment_id, ticket_id, discord_message_id, author, author_id,
        content, created_at, is_ai_question
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      comment.commentId, comment.ticketId, comment.discordMessageId,
      comment.author, comment.authorId, comment.content,
      comment.createdAt, comment.isAiQuestion ? 1 : 0
    );

    this.recordEvent(
      { ticketId: options.ticketId } as Ticket,
      'commented',
      options.author,
      options.authorId
    );

    return comment;
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private recordEvent(
    ticket: Ticket,
    type: TicketEvent['type'],
    actor: TicketEvent['actor'],
    actorId: string,
    details?: Record<string, any>
  ): void {
    this.db.prepare(`
      INSERT INTO ticket_events (event_id, ticket_id, type, actor, actor_id, timestamp, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(uuid(), ticket.ticketId, type, actor, actorId, new Date().toISOString(),
          details ? JSON.stringify(details) : null);
  }

  private rowToTicket(row: any): Ticket {
    return {
      ticketId: row.ticket_id,
      forumPostId: row.forum_post_id,
      forumChannelId: row.forum_channel_id,
      guildId: row.guild_id,
      type: row.type,
      status: row.status,
      priority: row.priority,
      assignee: row.assignee,
      assigneeUserId: row.assignee_user_id,
      title: row.title,
      description: row.description,
      createdBy: row.created_by,
      createdById: row.created_by_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      relatedSessionIds: JSON.parse(row.related_session_ids || '[]'),
      linkedCommitShas: JSON.parse(row.linked_commit_shas || '[]'),
      linkedPrUrls: JSON.parse(row.linked_pr_urls || '[]'),
      aiContext: row.ai_context ? JSON.parse(row.ai_context) : undefined
    };
  }
}
```

## Forum Bridge (tickets/forum-bridge.ts)

```typescript
import {
  ForumChannel,
  ChannelType,
  ThreadChannel,
  EmbedBuilder,
  MessageFlags
} from 'discord.js';
import type { TicketManager } from './ticket-manager.js';
import type { Ticket, ForumTagConfig } from './types.js';

export class ForumBridge {
  private ticketManager: TicketManager;
  private tagConfigs: Map<string, ForumTagConfig> = new Map();

  constructor(ticketManager: TicketManager) {
    this.ticketManager = ticketManager;
  }

  // ==========================================================================
  // Setup
  // ==========================================================================

  async configureForum(
    forumChannel: ForumChannel,
    config: ForumTagConfig
  ): Promise<void> {
    // Store tag configuration for this forum
    this.tagConfigs.set(forumChannel.id, config);

    // TODO: Persist to database
    console.log(`[ForumBridge] Configured forum ${forumChannel.name}`);
  }

  // ==========================================================================
  // Creating Tickets
  // ==========================================================================

  async createTicketPost(
    forumChannel: ForumChannel,
    options: {
      type: Ticket['type'];
      title: string;
      description: string;
      priority?: Ticket['priority'];
      authorId: string;
      authorName: string;
    }
  ): Promise<{ thread: ThreadChannel; ticket: Ticket }> {
    const tagConfig = this.tagConfigs.get(forumChannel.id);
    if (!tagConfig) {
      throw new Error(`Forum ${forumChannel.id} not configured`);
    }

    // Build applied tags
    const appliedTags = this.buildTags(tagConfig, {
      type: options.type,
      status: 'open',
      priority: options.priority || 'normal',
      assignee: 'unassigned'
    });

    // Create embed for initial message
    const embed = new EmbedBuilder()
      .setTitle(options.title)
      .setDescription(options.description)
      .addFields(
        { name: 'Type', value: this.formatType(options.type), inline: true },
        { name: 'Priority', value: this.formatPriority(options.priority || 'normal'), inline: true },
        { name: 'Status', value: 'Open', inline: true }
      )
      .setFooter({ text: `Created by ${options.authorName}` })
      .setTimestamp();

    // Create the forum post
    const thread = await forumChannel.threads.create({
      name: this.formatTitle(options.type, options.title),
      message: {
        embeds: [embed]
      },
      appliedTags
    });

    // Create ticket in database
    const ticket = await this.ticketManager.createTicket({
      forumPostId: thread.id,
      forumChannelId: forumChannel.id,
      guildId: forumChannel.guildId,
      type: options.type,
      title: options.title,
      description: options.description,
      priority: options.priority,
      createdBy: 'user',
      createdById: options.authorId
    });

    return { thread, ticket };
  }

  // ==========================================================================
  // Updating Tickets
  // ==========================================================================

  async updateTicketTags(
    thread: ThreadChannel,
    ticket: Ticket
  ): Promise<void> {
    const tagConfig = this.tagConfigs.get(ticket.forumChannelId);
    if (!tagConfig) return;

    const appliedTags = this.buildTags(tagConfig, {
      type: ticket.type,
      status: ticket.status,
      priority: ticket.priority,
      assignee: ticket.assignee
    });

    await thread.setAppliedTags(appliedTags);
  }

  async postStatusUpdate(
    thread: ThreadChannel,
    ticket: Ticket,
    message: string,
    actorName: string
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('Status Update')
      .setDescription(message)
      .addFields(
        { name: 'New Status', value: this.formatStatus(ticket.status), inline: true }
      )
      .setFooter({ text: `Updated by ${actorName}` })
      .setTimestamp()
      .setColor(this.getStatusColor(ticket.status));

    await thread.send({ embeds: [embed] });
  }

  async postAiQuestion(
    thread: ThreadChannel,
    question: string,
    context?: string
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('Question from AI')
      .setDescription(question)
      .setColor('Blue');

    if (context) {
      embed.addFields({ name: 'Context', value: context });
    }

    await thread.send({ embeds: [embed] });
  }

  async postAiProgress(
    thread: ThreadChannel,
    update: string,
    details?: string
  ): Promise<void> {
    const embed = new EmbedBuilder()
      .setTitle('AI Progress Update')
      .setDescription(update)
      .setColor('Yellow')
      .setTimestamp();

    if (details) {
      embed.addFields({ name: 'Details', value: details });
    }

    await thread.send({ embeds: [embed] });
  }

  // ==========================================================================
  // Tag Helpers
  // ==========================================================================

  private buildTags(
    config: ForumTagConfig,
    options: {
      type: Ticket['type'];
      status: Ticket['status'];
      priority: Ticket['priority'];
      assignee: Ticket['assignee'];
    }
  ): string[] {
    const tags: string[] = [];

    // Type tag
    switch (options.type) {
      case 'bug': tags.push(config.bugTagId); break;
      case 'feature': tags.push(config.featureTagId); break;
      case 'question': tags.push(config.questionTagId); break;
      case 'task': tags.push(config.taskTagId); break;
    }

    // Status tag
    tags.push(config.statusTags[options.status]);

    // Priority tag
    tags.push(config.priorityTags[options.priority]);

    // Assignee tag
    tags.push(config.assigneeTags[options.assignee]);

    return tags;
  }

  private formatTitle(type: Ticket['type'], title: string): string {
    const prefix = {
      bug: '[Bug]',
      feature: '[Feature]',
      question: '[Question]',
      task: '[Task]'
    }[type];

    return `${prefix} ${title}`.slice(0, 100); // Discord title limit
  }

  private formatType(type: Ticket['type']): string {
    return {
      bug: 'Bug Report',
      feature: 'Feature Request',
      question: 'Question',
      task: 'Task'
    }[type];
  }

  private formatPriority(priority: Ticket['priority']): string {
    return {
      low: 'Low',
      normal: 'Normal',
      high: 'High',
      urgent: 'Urgent'
    }[priority];
  }

  private formatStatus(status: Ticket['status']): string {
    return status.split('_').map(w =>
      w.charAt(0).toUpperCase() + w.slice(1)
    ).join(' ');
  }

  private getStatusColor(status: Ticket['status']): string {
    const colors: Record<Ticket['status'], string> = {
      open: 'Green',
      triage: 'Yellow',
      in_progress: 'Blue',
      blocked: 'Red',
      review: 'Purple',
      done: 'Grey',
      wontfix: 'Grey',
      duplicate: 'Grey'
    };
    return colors[status];
  }
}
```

## AI Ticket Tools (for Squire)

```typescript
// tickets/tools.ts - Tools to inject into AI sessions

export function getTicketTools(
  ticketManager: TicketManager,
  forumBridge: ForumBridge,
  squireId: string
): any[] {
  return [
    {
      name: 'ticket_list',
      description: 'List tickets. Can filter by status, type, or assignee.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['open', 'in_progress', 'blocked', 'review', 'all'],
            description: 'Filter by status'
          },
          type: {
            type: 'string',
            enum: ['bug', 'feature', 'question', 'task', 'all'],
            description: 'Filter by type'
          },
          assignedToMe: {
            type: 'boolean',
            description: 'Only show tickets assigned to AI'
          }
        }
      },
      execute: async (input: any) => {
        let tickets = input.status === 'all'
          ? ticketManager.getAllTickets()
          : ticketManager.getTicketsByStatus(input.status || 'open');

        if (input.type !== 'all' && input.type) {
          tickets = tickets.filter(t => t.type === input.type);
        }

        if (input.assignedToMe) {
          tickets = tickets.filter(t => t.assignee === 'ai');
        }

        return {
          output: formatTicketList(tickets),
          success: true
        };
      }
    },

    {
      name: 'ticket_view',
      description: 'View details of a specific ticket',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: {
            type: 'string',
            description: 'The ticket ID or forum post ID'
          }
        },
        required: ['ticketId']
      },
      execute: async (input: { ticketId: string }) => {
        const ticket = ticketManager.getTicket(input.ticketId) ||
                       ticketManager.getTicketByPostId(input.ticketId);

        if (!ticket) {
          return { output: 'Ticket not found', success: false };
        }

        const comments = ticketManager.getComments(ticket.ticketId);

        return {
          output: formatTicketDetail(ticket, comments),
          success: true
        };
      }
    },

    {
      name: 'ticket_claim',
      description: 'Claim a ticket to work on it',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: {
            type: 'string',
            description: 'The ticket ID to claim'
          }
        },
        required: ['ticketId']
      },
      execute: async (input: { ticketId: string }, context: any) => {
        const ticket = ticketManager.getTicket(input.ticketId);
        if (!ticket) {
          return { output: 'Ticket not found', success: false };
        }

        if (ticket.assignee !== 'unassigned') {
          return { output: 'Ticket already assigned', success: false };
        }

        await ticketManager.assignToSelf(ticket.ticketId, squireId);

        // Update Discord tags
        const thread = await context.discordClient.channels.fetch(ticket.forumPostId);
        if (thread?.isThread()) {
          await forumBridge.updateTicketTags(thread, {
            ...ticket,
            assignee: 'ai'
          });
        }

        return {
          output: `Claimed ticket #${ticket.ticketId}: ${ticket.title}`,
          success: true
        };
      }
    },

    {
      name: 'ticket_ask',
      description: 'Ask a clarifying question on a ticket',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: {
            type: 'string',
            description: 'The ticket ID'
          },
          question: {
            type: 'string',
            description: 'The question to ask'
          },
          context: {
            type: 'string',
            description: 'Optional context for the question'
          }
        },
        required: ['ticketId', 'question']
      },
      execute: async (input: { ticketId: string; question: string; context?: string }, context: any) => {
        const ticket = ticketManager.getTicket(input.ticketId);
        if (!ticket) {
          return { output: 'Ticket not found', success: false };
        }

        const thread = await context.discordClient.channels.fetch(ticket.forumPostId);
        if (!thread?.isThread()) {
          return { output: 'Could not access ticket thread', success: false };
        }

        const message = await forumBridge.postAiQuestion(thread, input.question, input.context);

        await ticketManager.addComment({
          ticketId: ticket.ticketId,
          discordMessageId: message.id,
          author: 'ai',
          authorId: squireId,
          content: input.question,
          isAiQuestion: true
        });

        return {
          output: `Posted question on ticket #${ticket.ticketId}`,
          success: true
        };
      }
    },

    {
      name: 'ticket_update',
      description: 'Post a progress update on a ticket',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: {
            type: 'string',
            description: 'The ticket ID'
          },
          update: {
            type: 'string',
            description: 'The progress update'
          },
          status: {
            type: 'string',
            enum: ['in_progress', 'blocked', 'review', 'done'],
            description: 'New status if changing'
          }
        },
        required: ['ticketId', 'update']
      },
      execute: async (input: { ticketId: string; update: string; status?: string }, context: any) => {
        const ticket = ticketManager.getTicket(input.ticketId);
        if (!ticket) {
          return { output: 'Ticket not found', success: false };
        }

        const thread = await context.discordClient.channels.fetch(ticket.forumPostId);
        if (!thread?.isThread()) {
          return { output: 'Could not access ticket thread', success: false };
        }

        await forumBridge.postAiProgress(thread, input.update);

        if (input.status && input.status !== ticket.status) {
          await ticketManager.setTicketStatus(ticket.ticketId, input.status as any, 'ai', squireId);
          await forumBridge.updateTicketTags(thread, {
            ...ticket,
            status: input.status as any
          });
        }

        return {
          output: `Posted update on ticket #${ticket.ticketId}`,
          success: true
        };
      }
    },

    {
      name: 'ticket_close',
      description: 'Close a ticket as done',
      inputSchema: {
        type: 'object',
        properties: {
          ticketId: {
            type: 'string',
            description: 'The ticket ID'
          },
          summary: {
            type: 'string',
            description: 'Summary of what was done'
          }
        },
        required: ['ticketId', 'summary']
      },
      execute: async (input: { ticketId: string; summary: string }, context: any) => {
        const ticket = ticketManager.getTicket(input.ticketId);
        if (!ticket) {
          return { output: 'Ticket not found', success: false };
        }

        const thread = await context.discordClient.channels.fetch(ticket.forumPostId);
        if (!thread?.isThread()) {
          return { output: 'Could not access ticket thread', success: false };
        }

        await ticketManager.setTicketStatus(ticket.ticketId, 'done', 'ai', squireId);

        const embed = new EmbedBuilder()
          .setTitle('Ticket Completed')
          .setDescription(input.summary)
          .setColor('Green')
          .setTimestamp();

        await thread.send({ embeds: [embed] });
        await forumBridge.updateTicketTags(thread, { ...ticket, status: 'done' });
        await thread.setLocked(true);

        return {
          output: `Closed ticket #${ticket.ticketId}`,
          success: true
        };
      }
    }
  ];
}

function formatTicketList(tickets: Ticket[]): string {
  if (tickets.length === 0) return 'No tickets found.';

  return tickets.map(t =>
    `#${t.ticketId.slice(0, 8)} [${t.type}] ${t.title}\n` +
    `  Status: ${t.status} | Priority: ${t.priority} | Assignee: ${t.assignee}`
  ).join('\n\n');
}

function formatTicketDetail(ticket: Ticket, comments: TicketComment[]): string {
  let out = `# ${ticket.title}\n\n`;
  out += `**Type:** ${ticket.type}\n`;
  out += `**Status:** ${ticket.status}\n`;
  out += `**Priority:** ${ticket.priority}\n`;
  out += `**Assignee:** ${ticket.assignee}\n\n`;
  out += `## Description\n${ticket.description}\n\n`;

  if (comments.length > 0) {
    out += `## Comments (${comments.length})\n`;
    comments.forEach(c => {
      out += `- **${c.author}**: ${c.content.slice(0, 100)}...\n`;
    });
  }

  return out;
}
```

## Discord Commands

### /ticket create

```typescript
import { SlashCommandBuilder, CommandInteraction, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } from 'discord.js';

export const ticketCommand = new SlashCommandBuilder()
  .setName('ticket')
  .setDescription('Ticket management commands')
  .addSubcommand(sub =>
    sub.setName('create')
      .setDescription('Create a new ticket')
      .addStringOption(opt =>
        opt.setName('type')
          .setDescription('Ticket type')
          .setRequired(true)
          .addChoices(
            { name: 'Bug Report', value: 'bug' },
            { name: 'Feature Request', value: 'feature' },
            { name: 'Question', value: 'question' },
            { name: 'Task', value: 'task' }
          )
      )
  )
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List tickets')
  )
  .addSubcommand(sub =>
    sub.setName('claim')
      .setDescription('Claim a ticket to work on')
      .addStringOption(opt =>
        opt.setName('ticket_id')
          .setDescription('Ticket ID')
          .setRequired(true)
      )
  );
```

## Forum Watcher

```typescript
// handlers/forum-watcher.ts
// Watches forum channels for new posts and updates

import { Events, ForumChannel, ThreadChannel } from 'discord.js';

export function setupForumWatcher(
  client: any,
  ticketManager: TicketManager,
  forumBridge: ForumBridge
): void {
  client.on(Events.ThreadCreate, async (thread: ThreadChannel) => {
    // Check if this is in a configured forum channel
    const parent = thread.parent;
    if (!parent || parent.type !== ChannelType.GuildForum) return;

    // Check if we manage this forum
    if (!forumBridge.isConfigured(parent.id)) return;

    // Get the starter message
    const starterMessage = await thread.fetchStarterMessage();

    // Create ticket from the forum post
    // (User created post directly in forum)
    const ticket = await ticketManager.createTicket({
      forumPostId: thread.id,
      forumChannelId: parent.id,
      guildId: thread.guildId,
      type: inferTicketType(thread.appliedTags, parent),
      title: thread.name,
      description: starterMessage?.content || '',
      createdBy: 'user',
      createdById: starterMessage?.author?.id || 'unknown'
    });

    console.log(`[ForumWatcher] Created ticket ${ticket.ticketId} from forum post`);
  });

  client.on(Events.MessageCreate, async (message) => {
    // Watch for replies in ticket threads
    if (!message.channel.isThread()) return;
    if (message.author.bot) return;

    const ticket = ticketManager.getTicketByPostId(message.channel.id);
    if (!ticket) return;

    // Record user comment
    await ticketManager.addComment({
      ticketId: ticket.ticketId,
      discordMessageId: message.id,
      author: 'user',
      authorId: message.author.id,
      content: message.content
    });
  });
}
```

## Database Schema

```sql
-- tickets.db

-- Main tickets table
CREATE TABLE tickets (
  ticket_id TEXT PRIMARY KEY,
  forum_post_id TEXT UNIQUE NOT NULL,
  forum_channel_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,

  type TEXT NOT NULL CHECK(type IN ('bug', 'feature', 'question', 'task')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'triage', 'in_progress', 'blocked', 'review', 'done', 'wontfix', 'duplicate')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low', 'normal', 'high', 'urgent')),

  assignee TEXT NOT NULL DEFAULT 'unassigned' CHECK(assignee IN ('unassigned', 'ai', 'user')),
  assignee_user_id TEXT,

  title TEXT NOT NULL,
  description TEXT,

  created_by TEXT NOT NULL CHECK(created_by IN ('user', 'ai')),
  created_by_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  related_session_ids TEXT DEFAULT '[]',
  linked_commit_shas TEXT DEFAULT '[]',
  linked_pr_urls TEXT DEFAULT '[]',

  ai_context TEXT
);

-- Comments on tickets
CREATE TABLE ticket_comments (
  comment_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  discord_message_id TEXT NOT NULL,

  author TEXT NOT NULL,
  author_id TEXT NOT NULL,

  content TEXT NOT NULL,
  created_at TEXT NOT NULL,

  is_ai_question INTEGER DEFAULT 0,
  is_status_update INTEGER DEFAULT 0,

  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
);

-- Event log
CREATE TABLE ticket_events (
  event_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  details TEXT,

  FOREIGN KEY (ticket_id) REFERENCES tickets(ticket_id)
);

-- Forum tag configurations
CREATE TABLE forum_tag_configs (
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  config_json TEXT NOT NULL,
  PRIMARY KEY (guild_id, channel_id)
);

-- Indexes
CREATE INDEX idx_tickets_status ON tickets(status);
CREATE INDEX idx_tickets_assignee ON tickets(assignee);
CREATE INDEX idx_tickets_type ON tickets(type);
CREATE INDEX idx_tickets_guild ON tickets(guild_id);
CREATE INDEX idx_comments_ticket ON ticket_comments(ticket_id);
```

## Configuration

```json
// ~/.squire/config.json
{
  "forums": {
    "guild_123": {
      "forumChannelId": "456...",
      "tagConfig": {
        "bugTagId": "tag_id_1",
        "featureTagId": "tag_id_2",
        "questionTagId": "tag_id_3",
        "taskTagId": "tag_id_4",
        "statusTags": {
          "open": "tag_id_open",
          "triage": "tag_id_triage",
          "in_progress": "tag_id_progress",
          "blocked": "tag_id_blocked",
          "review": "tag_id_review",
          "done": "tag_id_done",
          "wontfix": "tag_id_wontfix",
          "duplicate": "tag_id_duplicate"
        },
        "priorityTags": {
          "low": "tag_id_low",
          "normal": "tag_id_normal",
          "high": "tag_id_high",
          "urgent": "tag_id_urgent"
        },
        "assigneeTags": {
          "unassigned": "tag_id_unassigned",
          "ai": "tag_id_ai",
          "user": "tag_id_user"
        }
      }
    }
  }
}
```

## Usage Examples

### User creates a ticket
```
/ticket create type:bug
[Modal opens for title and description]
[Forum post created with tags: Bug, Open, Normal, Unassigned]
```

### AI picks up a ticket
```
User: Can you work on the login bug?

AI uses: ticket_list status:open type:bug
AI sees: #abc12345 [bug] Login fails with special characters
AI uses: ticket_claim ticketId:abc12345
AI posts: "I'm investigating the login bug. Looking at the auth code..."
AI uses: ticket_update ticketId:abc12345 update:"Found the issue - special chars not encoded" status:in_progress
```

### AI asks clarifying question
```
AI uses: ticket_ask ticketId:abc12345 question:"Which browser are you using?" context:"Need to check browser-specific encoding"

[Posts to Discord forum thread]
```

## Next Phase

- **Phase 9**: Advanced ticket features
  - Automatic ticket creation from error logs
  - Ticket linking and dependencies
  - SLA tracking
  - Metrics and reporting
