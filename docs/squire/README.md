# Squire - Personal AI Assistant

A personal AI assistant system that can work independently in the background, remember context across sessions, and be accessed via Discord.

## Overview

Squire is designed as a **separate package** that provides intelligent assistant capabilities. It can be used in two ways:

1. **Standalone with SquireBot** - Your own personal Discord bot
2. **Embedded in DisCode** - Via runner-agent plugin

```
┌─────────────────────────────────────────────────────────────────┐
│                         SQUIRE                                   │
│                    (The Agent Package)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   Skills    │  │   Memory    │  │  Scheduler  │              │
│  │   System    │  │   System    │  │   System    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    WORKSPACE MANAGER                         ││
│  │  - Each channel/thread = isolated workspace                  ││
│  │  - Shared global memory across all workspaces                ││
│  │  - Independent decision-making context per workspace         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌─────────────────┐           ┌─────────────────┐
│   SQUIRE BOT    │           │   DISCODE BOT   │
│ (Discord only)  │           │ (via runner-    │
│  Single-user    │           │  agent plugin)  │
│  Simple auth    │           │                 │
└─────────────────┘           └─────────────────┘
```

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
│   │   ├── mcp/               # MCP tools for agent
│   │   └── types.ts           # Type definitions
│   └── tests/
│
├── squire-bot/                # Discord bot for Squire (standalone)
│   ├── package.json           # @discode/squire-bot
│   ├── src/
│   │   ├── index.ts           # Bot entry point
│   │   ├── commands/          # /listen, /dm, /status, etc.
│   │   ├── handlers/          # Message, interaction handlers
│   │   ├── workspace-bridge.ts # Connect Discord to Squire workspaces
│   │   └── config.ts          # Single-user config
│   └── tests/
│
├── runner-agent/              # EXISTING - with Squire plugin
│   └── src/
│       └── squire-plugin/     # Plugin to embed Squire in DisCode
│
├── discord-bot/               # EXISTING - DisCode bot
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
| Multi-tenancy | Single-user | Multi-user |
| Permissions | Minimal prompts | Full permission system |
| Authentication | Single token | Per-runner tokens |
| Use case | Personal assistant | Team collaboration |
| Background tasks | Yes (daemon) | Session-based |
| Memory | Global + workspaces | Per-session |

## Design Decisions

### Why Separate SquireBot?
- Simplicity for personal use
- No need for complex multi-tenant infrastructure
- Can be more aggressive/autonomous with fewer permission prompts
- Easier to deploy for individual users

### Why Shared Memory?
- Squire "remembers" context from all conversations
- Learning in one workspace benefits others
- Personal knowledge graph builds over time

### Why Isolated Workspaces?
- Prevents context pollution between channels
- Each project/task has clean decision context
- But memory is still shared for cross-context recall

### Why Plugin Architecture?
- DisCode users don't need separate bot
- Same Squire core works in both contexts
- Easy to migrate from DisCode to standalone SquireBot
