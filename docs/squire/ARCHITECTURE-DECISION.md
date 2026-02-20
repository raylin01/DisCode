# Architecture Decision: Squire Architecture

## Executive Summary

**Recommendation: Dual-Connection Architecture**

Runner-agent with the Squire plugin connects to **BOTH** DisCode bot AND SquireBot simultaneously:
- **DisCode Bot** - Sessions, projects, multi-user collaboration
- **SquireBot** - DMs, forums, personal assistant, channel management

SquireBot is a **minimal Discord bot** that acts as a thin interface, with the "brains" in runner-agent's squire plugin.

## Current Architecture (Dual-Connection)

```
┌─────────────────────────────────────────────────────────────────┐
│                         RUNNER-AGENT                             │
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    PLUGINS (loaded together)                 ││
│  │                                                              ││
│  │  Core Plugins:              Squire Plugin:                  ││
│  │  - claude-sdk               - Memory system                 ││
│  │  - codex-sdk                - Ticket tools                  ││
│  │  - gemini-sdk               - Channel management tools      ││
│  │  - tmux                     - Scheduler                     ││
│  │                             - Skills loader                 ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                  │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                 DUAL CONNECTION (simultaneous)               ││
│  │                                                              ││
│  │  WebSocket to DisCode Bot ──────► Sessions, projects        ││
│  │  WebSocket to SquireBot ────────► DMs, forums, channels     ││
│  │                           (can be both simultaneously)      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────┐                  ┌─────────────────────────────────┐
│  DISCODE BOT    │                  │  SQUIRE BOT (minimal)           │
│  (unchanged)    │                  │                                 │
│                 │                  │  - WebSocket server             │
│  - Sessions     │                  │  - DM passthrough to runner     │
│  - Projects     │                  │  - Forum passthrough to runner  │
│  - Categories   │                  │  - Channel API for AI skills    │
│  - Multi-user   │                  │    (create, rename, post, etc)  │
└─────────────────┘                  └─────────────────────────────────┘
```

## Component Analysis

### SquireBot (Minimal Discord Bot)

**What it is:**
- A thin Discord bot that passes messages to runner-agent
- WebSocket server (same pattern as DisCode bot)
- Provides channel management API for AI skills
- No AI logic - just Discord interface

**Features:**
- DM handling (passthrough to runner-agent)
- Forum post watching (passthrough to runner-agent)
- Channel management API:
  - `create_channel` - AI can create channels
  - `send_message` - AI can post to any channel
  - `rename_channel` - AI can rename channels
  - `set_topic` - AI can set channel topics

**Architecture:**
```
Discord API
     │
     ▼
SquireBot Process
     │
     ├── Discord Client (discord.js)
     │   - Receives DMs, forum posts
     │   - Forwards to runner-agent via WS
     │
     └── WebSocket Server
         - Accepts connections from runner-agent
         - Executes channel operations from AI
         - Sends events (new DM, new forum post)
```

**Implementation effort:** ~1 week

---

### Squire Plugin (Runner-Agent)

**What it is:**
- A plugin for runner-agent that provides Squire capabilities
- Connects to SquireBot via WebSocket
- Provides AI tools for tickets, memory, channel management

**Features:**
- Memory system (SQLite-backed)
- Ticket tools (claim, update, close)
- Channel management tools (create, post, rename)
- Scheduler (daemon mode tasks)
- Skills system (YAML frontmatter)

**Architecture:**
```
Runner Agent
     │
     └── Squire Plugin
          ├── Memory Manager
          ├── Ticket Manager
          ├── Channel Tools
          ├── Scheduler
          └── Skills Manager

     Connects to:
     - SquireBot (WebSocket client)
     - Uses @discode/squire package
```

**Implementation effort:** ~2-3 weeks after SquireBot is ready

---

### DisCode Bot (Unchanged)

**What stays the same:**
- No Squire code added to discord-bot
- Continues to handle sessions, projects, categories
- Runner-agent connects as before

**Connection:**
- Runner-agent still connects to DisCode bot for sessions
- Same WebSocket protocol
- Squire plugin doesn't affect session handling

## Recommendation Details

### Channel Management Skills

The AI receives tools to manage Discord channels through SquireBot:

```typescript
// Channel management tools provided by squire plugin
const channelTools = [
  {
    name: 'create_channel',
    description: 'Create a new text or voice channel',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name' },
        type: { type: 'string', enum: ['text', 'voice', 'forum'], default: 'text' },
        parent: { type: 'string', description: 'Parent category ID (optional)' },
        topic: { type: 'string', description: 'Channel topic (optional)' }
      },
      required: ['name']
    },
    // Sends request to SquireBot via WebSocket
    execute: async (input, context) => {
      return context.squireBotClient.request('create_channel', input);
    }
  },
  {
    name: 'send_message',
    description: 'Send a message to a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Target channel ID' },
        content: { type: 'string', description: 'Message content' },
        embed: { type: 'object', description: 'Optional embed' }
      },
      required: ['channelId', 'content']
    }
  },
  {
    name: 'rename_channel',
    description: 'Rename a channel',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        newName: { type: 'string' }
      },
      required: ['channelId', 'newName']
    }
  },
  {
    name: 'set_channel_topic',
    description: 'Set a channel topic/description',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string' },
        topic: { type: 'string' }
      },
      required: ['channelId', 'topic']
    }
  },
  {
    name: 'create_forum_post',
    description: 'Create a post in a forum channel',
    inputSchema: {
      type: 'object',
      properties: {
        forumChannelId: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } }
      },
      required: ['forumChannelId', 'title', 'content']
    }
  }
];
```

### Project Structure After Implementation

```
DisCode/
├── squire/                          # Core package (@discode/squire)
│   ├── src/
│   │   ├── squire.ts               # Main class
│   │   ├── memory/                 # Memory system
│   │   ├── skills/                 # Skills system
│   │   ├── scheduler/              # Task scheduling
│   │   ├── workspace/              # Workspace management
│   │   ├── tickets/                # Ticket system
│   │   │   ├── ticket-manager.ts
│   │   │   ├── forum-bridge.ts
│   │   │   └── tools.ts
│   │   └── channel-tools/          # Channel management tools
│   │       ├── tools.ts            # Tool definitions
│   │       └── squirebot-client.ts # WebSocket client to SquireBot
│   └── package.json
│
├── squire-bot/                      # Minimal Discord bot
│   ├── src/
│   │   ├── index.ts                # Entry point
│   │   ├── discord-client.ts       # Discord.js setup
│   │   ├── ws-server.ts            # WebSocket server
│   │   ├── handlers/
│   │   │   ├── dm.ts               # DM passthrough
│   │   │   ├── forum.ts            # Forum post passthrough
│   │   │   └── channel-ops.ts      # Channel operations from AI
│   │   └── config.ts               # Single-user config
│   └── package.json
│
├── runner-agent/                    # EXISTING
│   └── src/
│       └── squire-plugin/           # Squire plugin
│           ├── index.ts             # Plugin entry
│           ├── tools.ts             # Inject all squire tools
│           └── squirebot-client.ts  # WS client to SquireBot
│
└── discord-bot/                     # EXISTING - No changes needed
    └── src/
        └── ... (session management, unchanged)
```

## WebSocket Protocol (SquireBot)

```typescript
// Messages from runner-agent -> SquireBot

// Channel operations
{ type: 'create_channel', requestId: '...', data: { name, type, topic } }
{ type: 'send_message', requestId: '...', data: { channelId, content, embed } }
{ type: 'rename_channel', requestId: '...', data: { channelId, newName } }
{ type: 'create_forum_post', requestId: '...', data: { forumChannelId, title, content, tags } }

// Messages from SquireBot -> runner-agent

// Events
{ type: 'dm_received', data: { userId, content, channelId } }
{ type: 'forum_post_created', data: { postId, forumChannelId, title, content, authorId } }
{ type: 'forum_post_replied', data: { postId, replyContent, authorId } }

// Responses
{ type: 'response', requestId: '...', success: true, data: { channelId: '...' } }
{ type: 'error', requestId: '...', error: 'Permission denied' }
```

## Technical Considerations

### Dual WebSocket Connections

Runner-agent maintains two WebSocket connections:
1. **DisCode Bot** - For sessions (existing)
2. **SquireBot** - For personal assistant features

```typescript
// In runner-agent
class ConnectionManager {
  private discodeWs: WebSocket;      // Existing
  private squirebotWs: WebSocket;    // New (optional)

  async connectToSquireBot(url: string, token: string): Promise<void> {
    this.squirebotWs = new WebSocket(url);
    // Handle events from SquireBot
    this.squirebotWs.on('message', this.handleSquireEvent.bind(this));
  }
}
```

### Data Storage

```
~/.discode/
├── runner-config.json
├── data/
│   ├── sessions/      # CLI sessions (existing)
│   └── squire/        # Squire data (new)
│       ├── memory.db
│       ├── tickets.db
│       └── skills/
└── logs/
```

### Permissions

SquireBot needs Discord permissions:
- Manage Channels (create, rename)
- Send Messages
- Read Message History
- Create Public/Private Threads
- Manage Threads (for forum posts)

## Conclusion

The **dual-connection architecture** is recommended because:

1. **No bloat to discord-bot** - Squire code stays in runner-agent
2. **Minimal SquireBot** - Just Discord interface, no AI logic
3. **Flexible** - Can run with or without DisCode bot
4. **Consistent** - Same WebSocket pattern as existing architecture
5. **Channel autonomy** - AI can manage its own channels via skills

## Implementation Priority

1. **Phase 1-5**: Core Squire package (memory, skills, scheduler, workspaces)
2. **Phase 6**: SquireBot (minimal Discord bot + WS server)
3. **Phase 7**: Squire plugin for runner-agent (connects to both bots)
4. **Phase 8**: Discussion Board (ticket tracker)

## Next Steps

1. Complete Phase 1-5 (Core Squire)
2. Build SquireBot with WebSocket server
3. Create Squire plugin for runner-agent
4. Add ticket tracker and channel management tools
