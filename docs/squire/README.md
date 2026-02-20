# Squire - Personal AI Assistant

A personal AI assistant system that can work independently in the background, remember context across sessions, and be accessed via Discord.

**Architecture Decision:** See [ARCHITECTURE-DECISION.md](./ARCHITECTURE-DECISION.md) for the recommendation on standalone SquireBot vs DisCode integration.

## Overview

Squire uses a **dual-connection architecture** where runner-agent connects to both DisCode bot and SquireBot:

```
┌─────────────────────────────────────────────────────────────────┐
│                         RUNNER-AGENT                             │
│                                                                  │
│  Core Plugins: claude-sdk, codex-sdk, gemini-sdk, tmux          │
│                                                                  │
│  Squire Plugin:                                                  │
│  - Memory system (SQLite)                                        │
│  - Ticket tools                                                  │
│  - Channel management tools                                      │
│  - Scheduler                                                     │
│  - Skills system                                                 │
│                                                                  │
│  Dual Connection (simultaneous):                                 │
│  - WebSocket to DisCode Bot → Sessions, projects                │
│  - WebSocket to SquireBot → DMs, forums, channel management     │
└─────────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────┐                  ┌─────────────────────────────────┐
│  DISCODE BOT    │                  │  SQUIRE BOT (minimal)           │
│  (unchanged)    │                  │                                 │
│                 │                  │  - WebSocket server             │
│  - Sessions     │                  │  - DM passthrough               │
│  - Projects     │                  │  - Forum passthrough            │
│  - Multi-user   │                  │  - Channel API for AI skills    │
└─────────────────┘                  └─────────────────────────────────┘
```

**Key points:**
- **SquireBot is minimal** - just Discord interface + WebSocket server
- **discord-bot is unchanged** - no squire code added
- **runner-agent does the work** - squire plugin provides all AI capabilities
- **Channel management as skills** - AI can create channels, post updates, etc.

## Key Features

### 1. Persistent Daemon Mode
- Always-on background process
- Self-scheduling tasks via `schedule_task` tool
- Polling-based scheduler (SQLite-backed)

### 2. Global Memory with Isolated Workspaces
- ONE shared memory database for all context
- Each Discord channel/thread = isolated workspace
- Workspaces have independent decision context
- Memory updates from one workspace visible to others

### 3. Skills System
- YAML frontmatter for skill metadata
- Auto-installation of skill dependencies
- Platform/env eligibility filtering
- Shared across all workspaces

### 4. Simple Permission Model
- Fewer prompts than DisCode (more independent)
- Single-token authentication for SquireBot
- Works autonomously within defined boundaries

### 5. Discussion Board / Ticket Tracker (Phase 8)
- Discord forum-based bug and feature request tracking
- AI can claim and work on tickets
- Status tracking via forum tags
- AI can ask clarifying questions on tickets
- Links tickets to sessions and commits

## Project Structure

```
discode/
├── squire/                    # The Squire agent package
│   ├── package.json           # @discode/squire
│   ├── src/
│   │   ├── index.ts           # Public API exports
│   │   ├── squire.ts          # Main Squire class
│   │   ├── workspace.ts       # Workspace management
│   │   ├── memory/            # Memory system (embeddings + search)
│   │   ├── skills/            # Skills system (frontmatter + loading)
│   │   ├── scheduler/         # Task scheduling (daemon mode)
│   │   ├── tickets/           # Ticket tracker system (Phase 8)
│   │   │   ├── ticket-manager.ts
│   │   │   ├── forum-bridge.ts
│   │   │   └── tools.ts
│   │   ├── channel-tools/     # Channel management tools
│   │   │   ├── tools.ts
│   │   │   └── squirebot-client.ts
│   │   ├── mcp/               # MCP tools for agent
│   │   └── types.ts           # Type definitions
│   └── tests/
│
├── squire-bot/                # Minimal Discord bot
│   ├── package.json           # @discode/squire-bot
│   ├── src/
│   │   ├── index.ts           # Entry point
│   │   ├── discord-client.ts  # Discord.js setup
│   │   ├── ws-server.ts       # WebSocket server
│   │   ├── handlers/
│   │   │   ├── dm.ts          # DM passthrough
│   │   │   ├── forum.ts       # Forum post passthrough
│   │   │   └── channel-ops.ts # Channel operations from AI
│   │   └── config.ts          # Single-user config
│   └── tests/
│
├── runner-agent/              # EXISTING - with Squire plugin
│   └── src/
│       └── squire-plugin/     # Squire plugin (connects to both bots)
│           ├── index.ts
│           ├── tools.ts
│           └── squirebot-client.ts
│
├── discord-bot/               # EXISTING - unchanged
└── shared/                    # EXISTING - shared types
```

## Implementation Phases

See individual phase documents:
- [Phase 1: Core Package](./phase-1-core.md) - Squire package foundation
- [Phase 2: Memory System](./phase-2-memory.md) - Embeddings + vector search
- [Phase 3: Skills System](./phase-3-skills.md) - Frontmatter + skill loading
- [Phase 4: Scheduler](./phase-4-scheduler.md) - Daemon mode + task scheduling
- [Phase 5: Workspaces](./phase-5-workspaces.md) - Channel-isolated contexts
- [Phase 6: SquireBot](./phase-6-squirebot.md) - Standalone Discord bot
- [Phase 7: DisCode Integration](./phase-7-discode-integration.md) - runner-agent plugin
- [Phase 8: Discussion Board](./phase-8-discussion-board.md) - Forum-based ticket tracker

## Usage Examples

### SquireBot (Standalone)

```bash
# Install and configure
npm install -g @discode/squire-bot
squire-bot init --token "YOUR_DISCORD_BOT_TOKEN"

# The bot is now running, accessible via:
# /listen - Start a workspace in current channel
# /dm - Have squire DM you (creates private workspace)
# /status - Check squire status
# /remember <fact> - Store a memory
# /recall <query> - Search memories
```

### DisCode Integration

```typescript
// In DisCode, users can interact with Squire via:
// /squire start - Spawn a squire in this thread
// /squire schedule <task> - Schedule a background task
// /squire remember <fact> - Add to memory
```

## Comparison: SquireBot vs DisCode Bot

| Feature | SquireBot | DisCode Bot |
|---------|-----------|-------------|
| Purpose | Personal assistant | Team collaboration |
| WebSocket | Server (accepts connections) | Server (accepts connections) |
| AI Logic | In runner-agent plugin | In runner-agent plugin |
| DMs | Yes (passthrough) | No |
| Forums | Yes (ticket tracking) | No |
| Channel Management | Yes (AI skills) | No |
| Sessions | No | Yes |
| Multi-user | No | Yes |
| Code changes | New minimal bot | Unchanged |

## Design Decisions

### Why Dual-Connection Architecture?
- runner-agent already connects to DisCode bot for sessions
- Adding SquireBot connection extends capabilities
- No changes needed to discord-bot
- Consistent WebSocket pattern

### Why Minimal SquireBot?
- Just Discord interface, no AI logic
- All smarts in runner-agent plugin
- Easy to maintain and debug
- Follows same pattern as DisCode bot

### Why Channel Management as Skills?
- AI can create channels for progress tracking
- AI can rename channels to reflect current work
- AI can post updates to dedicated channels
- Gives AI autonomy over its workspace

### Why Shared Memory?
- Squire "remembers" context from all conversations
- Learning in one workspace benefits others
- Personal knowledge graph builds over time

### Why Isolated Workspaces?
- Prevents context pollution between channels
- Each project/task has clean decision context
- But memory is still shared for cross-context recall
