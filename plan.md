# DisCode Project Plan
## Multi-Interface Orchestration Layer for AI Coding CLI Tools

---

## Executive Summary

**DisCode** is a distributed orchestration system that enables running AI coding CLI tools (Claude Code, Open Code, Gemini Code, etc.) through Discord. The Discord bot serves as the central server, allowing users to connect their own machines as "runners" and control them through Discord. Multiple users across multiple Discord guilds can use the system simultaneously.

### Key Requirements
1. **Discord bot as central server** - single bot serving multiple users and guilds
2. **Token-based runner authentication** - users generate tokens to link their runner agents to their Discord account
3. **Multi-runner support** - each user can have multiple runner machines
4. **Permission-based sharing** - users can grant access to their runners to other Discord users
5. **Private sessions** - all CLI sessions happen in private channels/threads
6. **Multi-user from day one** - designed for open source, anyone can use it

---

## Table of Contents
1. [Existing Solutions Research](#existing-solutions-research)
2. [Technical Approach & Architecture](#technical-approach--architecture)
3. [System Components](#system-components)
4. [Data Flow & Communication](#data-flow--communication)
5. [Implementation Phases](#implementation-phases)
6. [POC Requirements](#poc-requirements)
7. [Technical Decisions](#technical-decisions)
8. [Open Questions](#open-questions)

---

## Existing Solutions Research

### 1. zebbern/claude-code-discord
**Approach:** Single-machine Discord bot using Deno

**Key Features:**
- Direct Discord bot integration with slash commands
- Spawns Claude Code as child process using `Deno.Command`
- Maps Discord channels to git branches/project directories
- 48 commands covering Claude Code features
- Role-based access control for dangerous operations
- Worktree management for parallel development

**Architecture:**
```
Discord API → Deno Bot (index.ts) → spawn claude CLI → stdout/stderr parsing
```

**Pros:**
- Proven working implementation
- Rich command set
- Good Discord integration patterns

**Cons:**
- Single machine only
- No multi-runner support
- Tightly coupled to Claude Code only
- No shared backend for multiple runners

**Source:** [github.com/zebbern/claude-code-discord](https://github.com/zebbern/claude-code-discord)

### 2. sugyan/claude-code-webui
**Approach:** Web interface using backend + frontend

**Key Features:**
- Separate backend (Node.js/Deno) and frontend (Vite/React)
- Spawns Claude Code as child process
- Real-time streaming of Claude output
- Project directory selection UI
- Conversation history browsing
- Mobile-responsive design

**Architecture:**
```
Web UI (React/Vite) → Backend API → spawn claude CLI → stream output
```

**Output Capture Method:**
```typescript
// Typical pattern used
const claude = spawn('claude', ['--print', '--output-format', 'stream-json']);
claude.stdout.on('data', (chunk) => {
  // Parse JSON and emit via WebSocket
});
```

**Pros:**
- Clean separation of concerns
- Real-time streaming implementation
- Multi-runtime support (Node.js/Deno)

**Cons:**
- Web-only (no Discord)
- Single machine
- No multi-runner orchestration

**Source:** [github.com/sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui)

### 3. Claude Code Hooks System
**Capabilities:**
- 9 hook events: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `UserPromptSubmit`, `SessionStart`, `SessionEnd`, `PreCompact`, `Notification`
- JSON input via stdin with full context
- Access to transcripts, session info, tool inputs/outputs
- Can execute commands or use LLM prompts

**Key Variables Available:**
- `$TRANSCRIPT_PATH` - Full session history
- `$TOOL_INPUT`, `$TOOL_RESULT` - Tool execution data
- `$USER_PROMPT` - User's submitted prompt
- `session_id`, `cwd` - Session metadata

**Limitations:**
- Internal reasoning/thoughts are NOT exposed
- Only captures decisions and actions, not thinking process

**Sources:**
- [Claude Code Hooks Guide](https://medium.com/codebrainery/claude-code-hooks-transform-your-development-workflow-in-2025-caf6c93cbd5d)
- [Anthropic Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)

### 4. CLI Output Capture Patterns

**Node.js/Deno Child Process:**
```typescript
import { spawn } from 'child_process';

const child = spawn('claude', ['--print', '--output-format', 'stream-json']);

child.stdout.on('data', (data) => {
  const output = data.toString();
  // Parse and handle
});

child.stderr.on('data', (data) => {
  // Handle errors
});

child.on('close', (code) => {
  // Process terminated
});
```

**Key Considerations:**
- Use `stream-json` format for structured output
- Handle partial chunks (data arrives in fragments)
- Parse JSON line by line (JSONL format)
- Buffer management to prevent deadlocks

---

## Technical Approach & Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Discord Bot (Central Server)                  │
│                    Node.js/Deno + TypeScript                     │
│                                                                  │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────┐ │
│  │ Discord Bot     │  │ Token Auth       │  │ Permission    │ │
│  │ Manager         │  │ Manager          │  │ Manager       │ │
│  │                 │  │                  │  │               │ │
│  │ - Slash cmds    │  │ - Generate token │  │ - ACLs        │ │
│  │ - Events        │  │ - Validate token │  │ - Share       │ │
│  │ - Channels      │  │ - Link to user   │  │ - Revoke      │ │
│  └─────────────────┘  └──────────────────┘  └───────────────┘ │
│                                                                  │
│  ┌─────────────────┐  ┌───────────────┐  ┌──────────────────┐ │
│  │ WebSocket       │  │ Session       │  │ Persistence      │ │
│  │ Server          │  │ Manager       │  │ Layer            │ │
│  │                 │  │               │  │                  │ │
│  │ - Real-time     │  │ - Create      │  │ - Users          │ │
│  │ - Bi-directional│  │ - Route       │  │ - Tokens         │ │
│  │ - Runner conns  │  │ - Terminate   │  │ - Sessions       │ │
│  └─────────────────┘  └───────────────┘  └──────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             │ WebSocket (runners connect directly)
                             │ wss://discode-bot.com/runner
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Runner Agent   │ │  Runner Agent   │ │  Runner Agent   │
│  (User A's      │ │  (User A's      │ │  (User B's      │
│   Mac)          │ │   Linux Server) │ │   Windows PC)   │
│                 │ │                 │ │                 │
│  Token: abc123  │ │  Token: abc123  │ │  Token: def456  │
└────────┬────────┘ └────────┬────────┘ └────────┬────────┘
         │                  │                  │
         │ spawn()          │ spawn()          │ spawn()
         ▼                  ▼                  ▼
    ┌────────┐        ┌────────┐         ┌────────┐
    │ claude │        │ claude │         │ gemini │
    └────────┘        └────────┘         └────────┘
```

### Key Design Principles

1. **Discord Bot = Central Server**
   - No separate backend service
   - Bot serves multiple users and guilds
   - Runners connect directly to bot via WebSocket

2. **Token-Based Authentication**
   - Users generate unique tokens via `/generate-token`
   - Tokens link runner agents to Discord accounts
   - Runners authenticate using these tokens

3. **Permission System**
   - Each runner belongs to a specific Discord user
   - Owner can grant access to other users
   - Runners can be private or shared

4. **Private Sessions**
   - Each CLI session gets a private thread/channel
   - Only authorized users can access
   - Real-time output streaming

---

## System Components

### 1. Discord Bot (Central Server)

**Technology Stack:** Node.js or Deno with TypeScript

**Responsibilities:**
- Discord bot management and slash command handling
- Token generation and validation
- Permission and access control management
- Session lifecycle management
- WebSocket server for runner connections
- Message routing between Discord and runners
- Persistence (users, tokens, sessions, permissions)

**Key Modules:**

#### Discord Bot Manager
```typescript
class DiscordBotManager {
  // Slash command handlers
  handleGenerateToken(userId: string): Promise<string>
  handleListRunners(userId: string): Promise<RunnerInfo[]>
  handleCreateSession(userId: string, runnerId: string): Promise<Session>
  handleShareRunner(userId: string, runnerId: string, targetUserId: string): Promise<void>
  handleRevokeAccess(userId: string, runnerId: string, targetUserId: string): Promise<void>

  // Event handlers
  onMessage(channelId: string, content: string, userId: string): Promise<void>
  onReactionAdd(messageId: string, emoji: string, userId: string): Promise<void>

  // Channel management
  createPrivateThread(sessionId: string, ownerId: string): Promise<string>
  inviteUserToThread(threadId: string, userId: string): Promise<void>
  streamToChannel(channelId: string, output: string): Promise<void>
}
```

#### Token Auth Manager
```typescript
class TokenAuthManager {
  // Token lifecycle
  generateToken(userId: string, guildId: string): Promise<string>
  validateToken(token: string): Promise<TokenInfo | null>
  revokeToken(token: string): Promise<void>
  listUserTokens(userId: string): Promise<TokenInfo[]>

  // Token validation for runners
  authenticateRunner(token: string): Promise<AuthenticationResult>
  refreshToken(token: string): Promise<string>
}

interface TokenInfo {
  token: string;
  userId: string;
  guildId: string;
  createdAt: Date;
  lastUsed: Date;
  isActive: boolean;
}
```

#### Permission Manager
```typescript
class PermissionManager {
  // Runner ownership
  assignRunnerOwner(runnerId: string, userId: string): Promise<void>
  getRunnerOwner(runnerId: string): Promise<string | null>

  // Access control
  grantAccess(runnerId: string, ownerId: string, targetUserId: string): Promise<void>
  revokeAccess(runnerId: string, ownerId: string, targetUserId: string): Promise<void>
  checkAccess(runnerId: string, userId: string): Promise<boolean>

  // List permissions
  listAuthorizedUsers(runnerId: string): Promise<string[]>;
  listAccessibleRunners(userId: string): Promise<RunnerInfo[]>;
}
```

#### Session Manager
```typescript
class SessionManager {
  createSession(config: SessionConfig): Promise<Session>
  terminateSession(sessionId: string): Promise<void>
  routeCommand(sessionId: string, command: string): Promise<void>
  getSessionRunner(sessionId: string): Promise<RunnerInfo | null>

  // Session visibility
  isUserAuthorizedForSession(sessionId: string, userId: string): Promise<boolean>
  addSessionViewer(sessionId: string, userId: string): Promise<void>
  removeSessionViewer(sessionId: string, userId: string): Promise<void>
}
```

#### WebSocket Server (for Runners)
```typescript
class RunnerWebSocketServer {
  // Connection management
  onRunnerConnect(ws: WebSocket, token: string): Promise<void>
  onRunnerDisconnect(runnerId: string): Promise<void>

  // Message handling
  sendCommandToRunner(runnerId: string, command: RunnerCommand): Promise<void>
  handleRunnerMessage(runnerId: string, message: RunnerMessage): Promise<void>

  // Broadcasting
  broadcastToRunners(runnerIds: string[], message: RunnerCommand): Promise<void>
}

interface RunnerCommand {
  type: 'CREATE_SESSION' | 'SEND_INPUT' | 'TERMINATE_SESSION' | 'HEALTH_CHECK';
  sessionId?: string;
  cliType?: string;
  workingDirectory?: string;
  input?: string;
}
```

### 2. Runner Agent

**Technology Stack:** Node.js or Deno with TypeScript

**Responsibilities:**
- Connect to Discord bot via WebSocket using authentication token
- Spawn and manage AI coding CLI processes
- Capture and parse CLI output in real-time
- Forward output to Discord bot
- Handle system resources and process limits
- Health monitoring and auto-reconnection

**Configuration File (`~/.discode/config.json`):**
```json
{
  "token": "abc123def456...",  // Generated from /generate-token
  "botUrl": "wss://discode-bot.com/runner",
  "runnerName": "my-macbook-pro",
  "maxSessions": 5,
  "workingDirectory": "/Users/username/projects",
  "supportedCLIs": ["claude", "open-code", "gemini"]
}
```

**Key Modules:**

#### Runner Client
```typescript
class RunnerClient {
  private ws: WebSocket;
  private config: RunnerConfig;
  private sessions: Map<string, CLISession>;

  // Connection lifecycle
  async connect(token: string): Promise<void>
  async disconnect(): Promise<void>

  // Authentication
  async authenticate(token: string): Promise<AuthResult>
  async sendHeartbeat(): Promise<void>

  // Message handling
  onCommand(command: RunnerCommand): Promise<void>
  sendOutput(message: RunnerOutput): Promise<void>

  // Reconnection
  async reconnect(): Promise<void>
  isConnected(): boolean
}
```

#### CLI Spawner
```typescript
class CLISpawner {
  spawnSession(cliType: CLIType, options: SpawnOptions): Promise<CLISession>
  terminateSession(sessionId: string): Promise<void>
  getSessionStatus(sessionId: string): Promise<SessionStatus>

  // Supported CLIs
  private spawnClaude(options: SpawnOptions): Promise<CLISession>
  private spawnOpenCode(options: SpawnOptions): Promise<CLISession>
  private spawnGemini(options: SpawnOptions): Promise<CLISession>
}
```

#### Output Parser
```typescript
class OutputParser {
  parse(chunk: Buffer): ParsedOutput | null
  detectOutputType(chunk: string): OutputType

  // Parse different formats
  private parseStreamJSON(line: string): ParsedOutput | null
  private parsePlainText(line: string): ParsedOutput | null
  private parseANSI(line: string): ParsedOutput | null

  // Extract structured data
  extractToolUse(output: string): ToolUse | null
  extractTerminalOutput(output: string): TerminalOutput | null
  extractThoughts(output: string): Thought[] | null
}
```

#### Health Monitor
```typescript
class HealthMonitor {
  // System metrics
  getCPUUsage(): Promise<number>
  getMemoryUsage(): Promise<MemoryInfo>
  getDiskUsage(): Promise<DiskInfo>

  // Process monitoring
  getSessionResourceUsage(sessionId: string): Promise<ResourceUsage>
  killResourceHogSession(sessionId: string): Promise<void>

  // Health reporting
  generateHealthReport(): Promise<HealthReport>
}
```

**Runner Agent Entry Point:**
```typescript
// discode-runner.ts
import { RunnerClient } from './client';
import { config } from './config';

const runner = new RunnerClient(config);

// Connect to bot
await runner.connect(config.token);

console.log(`Runner ${config.runnerName} connected to DisCode bot`);
console.log('Waiting for sessions...');

// Graceful shutdown
process.on('SIGINT', async () => {
  await runner.disconnect();
  process.exit(0);
});
```

### 3. Discord Interface

#### Channel Structure
```
Discord Server
├── #discode-setup (setup channel)
│   ├── /generate-token - Generate runner token
│   ├── /my-runners - List your runners
│   └── /share-runner <runner-id> <@user> - Grant access
│
├── 📁 sessions (category - one per runner)
│   ├── #runner-abc123-macbook (private thread)
│   │   └── Session sub-threads
│   ├── #runner-abc123-linux (private thread)
│   │   └── Session sub-threads
│   └── #runner-def456-pc (private thread)
│       └── Session sub-threads
│
└── #discode-feed (optional - server-wide feed)
    ├── Action items summaries
    ├── Session completion notifications
    └── Runner status updates
```

#### Slash Commands

**Setup Commands:**
```
/generate-token
  - Generates a unique authentication token
  - Token links your runner agents to your Discord account
  - Output: Token displayed in ephemeral message
  - Example: "Your runner token: abc123def456..."
  - Usage: Put this token in ~/.discode/config.json

/my-runners
  - Lists all your connected runner agents
  - Shows: runner name, status, active sessions, system info
  - Only shows your own runners

/list-tokens
  - Lists all your active tokens
  - Shows: token created date, last used, status
  - Can revoke old tokens

/revoke-token <token>
  - Revokes a token (runner will disconnect)
```

**Session Commands:**
```
/start-session <runner-id> [cli-type] [project-path]
  - Starts a new CLI session on specified runner
  - cli-type: claude (default) | open-code | gemini
  - Creates a private thread for the session
  - Only works with runners you own or have access to

/list-sessions [runner-id]
  - Lists active sessions
  - Shows: session ID, runner, CLI type, status, duration
  - Filter by runner or show all accessible sessions
```

**Sharing Commands:**
```
/share-runner <runner-id> <@user>
  - Grants access to your runner to another user
  - User can start sessions on your runner
  - Can revoke access later

/unshare-runner <runner-id> <@user>
  - Revokes access to your runner

/list-access <runner-id>
  - Lists all users with access to a runner
  - Only shows for runners you own
```

**Session Management (inside session threads):**
```
/kill-session
  - Terminates the current session

/invite <@user>
  - Invites a user to the current session thread
  - User can view and interact with the session
```

**Info Commands:**
```
/runner-status <runner-id>
  - Shows detailed status of a runner
  - CPU, memory, disk usage
  - Active sessions
  - System information

/my-access
  - Lists all runners you have access to
  - Shows owner and permission level
```

---

## Data Flow & Communication

### 1. Runner Registration Flow

```
User: /generate-token
   ↓
Discord Bot generates unique token
   ↓
Token stored in database linked to:
  - Discord User ID
  - Discord Guild ID
  - Timestamp
   ↓
Token displayed to user (ephemeral)
   ↓
User creates ~/.discode/config.json:
  {
    "token": "abc123def456...",
    "botUrl": "wss://discode-bot.com/runner",
    "runnerName": "my-macbook-pro"
  }
   ↓
User starts runner agent: discode-runner
   ↓
Runner connects to bot via WebSocket
   ↓
Runner sends authentication message:
  {
    type: "AUTHENTICATE",
    token: "abc123def456...",
    runnerName: "my-macbook-pro",
    systemInfo: { ... }
  }
   ↓
Bot validates token
   ↓
Bot links runner to Discord user
   ↓
Runner registered and ready for sessions
```

### 2. Session Creation Flow

```
User: /start-session runner-abc123 claude /path/to/project
   ↓
Discord Bot validates:
  - User owns or has access to runner
  - Runner is online
  - Runner supports requested CLI
   ↓
Bot creates session record
   ↓
Bot sends WebSocket message to Runner:
  {
    type: "CREATE_SESSION",
    sessionId: "sess_xyz789",
    cliType: "claude",
    workingDirectory: "/path/to/project",
    userId: "user_id",
    guildId: "guild_id"
  }
   ↓
Runner spawns claude process with stream-json format
   ↓
Runner creates private thread in Discord for session
   ↓
Thread name: "Session sess_xyz789 (claude)"
   ↓
Only owner and authorized users can access thread
   ↓
Runner sends confirmation: { type: "SESSION_READY", sessionId: "sess_xyz789" }
   ↓
Session ready for user input
```

### 3. Real-Time Output Streaming

```
Claude CLI outputs to stdout
   ↓
Runner reads data chunk from child.stdout
   ↓
OutputParser parses JSON/text
   ↓
Runner sends WebSocket message to Bot:
  {
    type: "OUTPUT",
    sessionId: "sess_xyz789",
    output: {
      type: "assistant_message" | "tool_use" | "terminal" | "error",
      content: "...",
      timestamp: "..."
    }
  }
   ↓
Bot routes to appropriate Discord thread
   ↓
Bot checks user permissions for session
   ↓
Bot streams to session's Discord thread
   ↓
Updates in real-time in Discord
```

### 4. User Input Flow

```
User types message in session thread
   ↓
Discord Bot receives message
   ↓
Bot validates user has access to session
   ↓
Bot sends WebSocket message to Runner:
  {
    type: "USER_INPUT",
    sessionId: "sess_xyz789",
    input: "help me refactor this function",
    userId: "user_id"
  }
   ↓
Runner writes to claude process stdin
   ↓
Claude processes and responds
   ↓ (back to output streaming flow)
```

### 5. Sharing Runner Flow

```
User A (owner): /share-runner runner-abc123 @UserB
   ↓
Bot validates User A owns runner-abc123
   ↓
Bot adds permission to database:
  {
    runnerId: "runner-abc123",
    ownerId: "user_a_id",
    authorizedUserId: "user_b_id",
    grantedAt: timestamp
  }
   ↓
Bot notifies User B via DM:
  "User A has shared runner 'my-macbook-pro' with you.
   You can now start sessions on this runner using /start-session"
   ↓
User B can now: /start-session runner-abc123 ...
   ↓
Session creates private thread
   ↓
Both User A and User B have access
```

### 6. Multi-Runner Architecture

```
User A's Runners                User B's Runners
┌─────────────────┐          ┌─────────────────┐
│ Runner 1 (Mac)  │          │ Runner 1 (PC)   │
│ Token: abc123   │          │ Token: def456   │
└────────┬────────┘          └────────┬────────┘
         │                            │
         ├── WebSocket ────────┬─────┤
         │                     │     │
         ▼                     ▼     ▼
    ┌────────────────────────────────┐
    │      Discord Bot (Central)      │
    │  ┌─────────────────────────┐   │
    │  │ Token Auth Manager      │   │
    │  │ - Links tokens to users │   │
    │  │ - Validates runners     │   │
    │  └─────────────────────────┘   │
    │  ┌─────────────────────────┐   │
    │  │ Permission Manager      │   │
    │  │ - ACLs for runners      │   │
    │  │ - Access control        │   │
    │  └─────────────────────────┘   │
    │  ┌─────────────────────────┐   │
    │  │ Session Manager         │   │
    │  │ - Route to runners      │   │
    │  │ - Handle failures       │   │
    │  └─────────────────────────┘   │
    └────────────────────────────────┘
         │                     │
         ▼                     ▼
    Discord (Interface)
    - Multiple guilds
    - Many users
    - Private sessions
---

## Implementation Phases

### Phase 1: Proof of Concept (2-3 weeks)

**Goal:** Validate core technical approach with multi-user support

**Deliverables:**
1. Discord bot with basic slash commands
2. Token generation and authentication
3. Single runner agent with token auth
4. One CLI support (Claude Code)
5. Output capture and streaming to private threads
6. Basic permission system

**Features:**
- `/generate-token` - Generate runner tokens
- `/my-runners` - List connected runners
- `/start-session` - Start CLI sessions
- Basic permission checks (owner only)

**Success Criteria:**
- User can generate token
- Runner connects with token
- Can spawn Claude Code from Discord
- Output appears in private Discord thread
- Can send commands back to Claude
- Session can be terminated
- Only token owner can access their runner

**Technical Validation:**
- ✅ Token-based authentication works
- ✅ Can we capture all needed output via CLI stdout?
- ✅ Can we parse `stream-json` format reliably?
- ✅ Can we maintain multiple concurrent sessions?

### Phase 2: Multi-Runner & Enhanced Permissions (2-3 weeks)

**Goal:** Enable multiple runners per user and sharing

**Deliverables:**
1. Multiple runners per user
2. Runner health monitoring and heartbeat
3. Permission system for sharing runners
4. Enhanced slash commands

**New Features:**
- `/share-runner <runner-id> <@user>` - Grant access
- `/unshare-runner <runner-id> <@user>` - Revoke access
- `/list-access <runner-id>` - Show authorized users
- `/my-access` - Show accessible runners
- Runner reconnection on connection loss
- Runner status display (CPU, memory, sessions)

**Success Criteria:**
- User can connect multiple runners
- Runners can be shared with other users
- Shared users can start sessions
- Runners auto-reconnect
- Health monitoring works

### Phase 3: Enhanced Discord Experience (2-3 weeks)

**Goal:** Polish Discord UX with better organization

**Deliverables:**
1. Improved channel organization
2. Rich embeds for different output types
3. Session management improvements
4. Action item extraction and display

**New Features:**
- Rich embeds for tool use, terminal output, errors
- Session sub-threads within runner threads
- Action items automatically extracted
- Session search and filtering
- Better error messages and help text
- Runner-specific channels/threads organization

### Phase 4: Multi-CLI Support (1-2 weeks)

**Goal:** Support multiple AI coding CLIs

**Deliverables:**
1. Open Code integration
2. Gemini Code integration
3. CLI-agnostic output parser
4. CLI-specific feature detection

**Architecture:**
```typescript
interface CLIAdapter {
  name: string;
  spawnCommand(): string[];
  outputFormat: 'stream-json' | 'text' | 'custom';
  parseOutput(chunk: string): ParsedOutput;
  detectCapability(capability: string): boolean;
}

class ClaudeAdapter implements CLIAdapter { ... }
class OpenCodeAdapter implements CLIAdapter { ... }
class GeminiAdapter implements CLIAdapter { ... }
```

**New Commands:**
- `/start-session <runner-id> <cli-type> ...`
- CLI type selection in slash command

### Phase 5: Production Readiness (2-3 weeks)

**Goal:** Make it robust and open-source ready

**Deliverables:**
1. Comprehensive error handling
2. Logging and monitoring
3. Configuration management
4. Docker deployment
5. Documentation (README, CONTRIBUTING, API docs)
6. Test suite

**Additional Features:**
- Configuration file validation
- Graceful shutdown handling
- Session persistence across restarts
- Error recovery and retry logic
- Metrics and monitoring endpoints

---

## POC Requirements

### What We Need to Validate

#### 1. Output Capture Completeness

**Question:** Can we get all information we need from CLI output?

**Approach:**
```bash
# Test capturing different output types
claude --print --output-format stream-json << 'EOF'
/help me write a function
EOF
```

**Check:**
- [ ] User messages captured
- [ ] Assistant responses captured
- [ ] Tool use (Read, Write, Edit, Bash) captured
- [ ] Tool results captured
- [ ] Terminal output captured
- [ ] Errors captured
- [ ] Session start/end captured

**Validation:** Build a simple test script that spawns Claude and logs all output types

#### 2. Real-Time Parsing

**Question:** Can we parse `stream-json` reliably in real-time?

**Approach:**
```typescript
// Test parser with real Claude output
const testCases = [
  'Complete JSON objects',
  'Partial/chunked JSON',
  'Multiple JSONs in one chunk',
  'JSON split across chunks',
  'Non-JSON output',
  'ANSI codes',
  'Emoji and unicode'
];
```

**Success Criteria:**
- No data loss
- No JSON parse errors
- Handles partial chunks correctly
- Performs under load (10+ concurrent sessions)

#### 3. Discord Rate Limits

**Question:** Can we stream output without hitting rate limits?

**Discord Limits:**
- 50 messages per channel per minute (bots)
- 2000 characters per message
- One embed per message

**Mitigation Strategies:**
- Batch output chunks
- Use edits instead of new messages when appropriate
- Implement queue with rate limit awareness
- Use file uploads for large output

**Validation:** Simulate high-volume output and test

#### 4. CLI Interaction & Interactive Prompts ← **CRITICAL FOR POC**

**Question:** Can we detect and handle Claude Code's interactive prompts?

**What we need to test:**
- Tool use approval prompts (Allow/Deny)
- File operation confirmations
- Choice selections (multiple choice prompts)
- Any other interactive elements

**Approach:**
```bash
# Test with prompts that require approval
claude --print --permission-mode ask << 'EOF'
/delete all files in test directory
EOF
```

**Expected Behavior:**
- Claude Code should prompt for approval
- We need to detect this prompt format
- Send to Discord as interactive buttons
- User clicks button
- Send choice back to CLI stdin

**Success Criteria:**
- [ ] Can detect approval prompts
- [ ] Can expose as Discord buttons
- [ ] Can send user's choice back to CLI
- [ ] Session continues after choice
- [ ] Handles timeouts (what if user doesn't respond?)

**Implementation Plan:**
1. Spawn Claude with `--permission-mode ask`
2. Parse stdout for prompt patterns
3. Detect when Claude is waiting for input
4. Send Discord message with buttons
5. On button click, write to stdin
6. Continue processing output

### 5. Token-Based Authentication

**Question:** Does token auth work securely?

**Approach:**
```typescript
// Test token generation, validation, revocation
const token = await generateToken(userId);
const auth = await validateToken(token);
await revokeToken(token);
const auth2 = await validateToken(token); // Should fail
```

**Check:**
- [ ] Tokens are unique
- [ ] Tokens link to correct user
- [ ] Revoked tokens don't work
- [ ] Expired tokens don't work
- [ ] WebSocket authentication works

### POC Architecture

```
┌─────────────────────────────┐
│  Discord Bot                │
│  - discord.js               │
│  - ws (WebSocket server)    │
│  - SQLite                   │
└──────────┬──────────────────┘
           │
           │ WebSocket (wss://...)
           │
┌──────────▼──────────────────┐
│  Runner Agent               │
│  - ws (WebSocket client)    │
│  - spawn claude             │
│  - parse output             │
│  - token in config.json     │
└─────────────────────────────┘
```

### POC Tech Stack

**Discord Bot:**
- Node.js 20+
- TypeScript
- discord.js (Discord bot)
- ws (WebSocket server)
- better-sqlite3 (persistence)

**Runner Agent:**
- Node.js 20+ or Deno
- TypeScript
- ws (WebSocket client)
- commander (CLI parsing)

---

## Technical Decisions

### 1. Runtime: Node.js vs Deno

**Node.js:**
- ✅ Larger ecosystem
- ✅ More familiar to most developers
- ✅ Better library support (especially Discord)
- ✅ Better debugging tools
- ❌ Requires build step for TypeScript
- ❌ More dependency management

**Deno:**
- ✅ Native TypeScript
- ✅ Built-in testing and formatting
- ✅ Better security model
- ✅ Single binary deployment
- ❌ Smaller ecosystem
- ❌ Less Discord library maturity

**Decision:** **Node.js** for Discord bot, **Node.js/Deno both** for runners

**Rationale:**
- Discord bot needs rich Discord ecosystem → Node.js
- Runners can be flexible → support both runtimes
- User's choice for runner runtime

### 2. Output Capture: Hooks vs CLI Parsing

**Claude Code Hooks:**
- ✅ Structured events
- ✅ Complete context (transcripts, tool IO)
- ✅ Can modify behavior
- ❌ Requires plugin installation
- ❌ Doesn't capture internal thoughts
- ❌ Adds complexity to user setup

**CLI Output Parsing:**
- ✅ Works with any CLI
- ✅ No setup required
- ✅ Simpler deployment
- ✅ Can capture everything that appears in terminal
- ❌ Need to parse unstructured text
- ❌ May miss some context

**Decision:** **CLI Output Parsing (primary)**, **Hooks (optional enhancement)**

**Rationale:**
- Primary goal is to orchestrate CLIs as-is
- Hooks add setup friction for users
- Can add hooks later for enhanced features
- `stream-json` format gives structured data

### 3. Authentication: Token System

**Approach:**
- Generate unique tokens per user
- Store tokens linked to Discord user ID
- Runners authenticate using tokens
- Simple, secure, easy to understand

**Security Considerations:**
- Tokens should be random and long enough (256 bits)
- Tokens stored hashed in database
- Tokens can be revoked
- Tokens expire after inactivity (optional)

### 4. Communication: WebSocket vs Polling

**WebSocket:**
- ✅ Real-time bidirectional
- ✅ Lower latency
- ✅ Efficient (no repeated requests)
- ❌ More complex state management
- ❌ Connection handling complexity

**Polling:**
- ✅ Simpler implementation
- ✅ Easier state management
- ✅ HTTP-based (firewall friendly)
- ❌ Higher latency
- ❌ More server load
- ❌ Not truly real-time

**Decision:** **WebSocket**

**Rationale:**
- Real-time output streaming is core requirement
- Discord uses WebSocket anyway
- Can implement with reconnection logic
- Worth the complexity for UX

### 5. Session State: Centralized vs Distributed

**Decision:** **Centralized metadata, distributed sessions**

**Rationale:**
- Bot holds session metadata only (who, where, status)
- Actual session state lives in CLI process on runner
- Simpler coordination
- Can evolve to distributed later

### 6. Persistent Storage System

**Decision:** **File-based YAML storage**

**Storage Layout:**
```
~/.discode-bot/
├── data.yaml              # Main database
├── data.yaml.backup       # Automatic backups
└── sessions/              # Session-specific data
    ├── {sessionId}.yaml   # Per-session state
    └── transcripts/       # Optional: full transcripts
        └── {sessionId}.txt
```

**data.yaml Structure:**
```yaml
version: "1.0"
lastUpdated: "2025-01-15T10:30:00Z"

users:
  "discord_user_id_1":
    username: "user#1234"
    tokens:
      - token: "abc123..."
        createdAt: "2025-01-15T10:00:00Z"
        lastUsed: "2025-01-15T10:30:00Z"
        isActive: true
    runners:
      - runnerId: "runner_macbook_abc"
        name: "my-macbook-pro"
        registeredAt: "2025-01-15T10:05:00Z"
        lastSeen: "2025-01-15T10:29:00Z"
        status: "online"
        systemInfo:
          os: "darwin"
          arch: "arm64"
          maxSessions: 5
        sharedWith:
          - "discord_user_id_2"

runners:
  "runner_macbook_abc":
    ownerId: "discord_user_id_1"
    token: "abc123..."
    name: "my-macbook-pro"
    status: "online"
    currentSessions: 2
    supportedCLIs:
      - claude
      - open-code
    authorizedUsers:
      - "discord_user_id_1"  # owner
      - "discord_user_id_2"  # shared

sessions:
  "sess_xyz789":
    runnerId: "runner_macbook_abc"
    ownerId: "discord_user_id_1"
    cliType: "claude"
    workingDirectory: "/Users/user/project"
    createdAt: "2025-01-15T10:15:00Z"
    status: "active"
    threadId: "1234567890"
    participants:
      - "discord_user_id_1"
      - "discord_user_id_2"

permissions:
  "runner_macbook_abc|discord_user_id_2":
    grantedBy: "discord_user_id_1"
    grantedAt: "2025-01-15T10:20:00Z"
    canStartSessions: true
```

**Advantages:**
- ✅ Human-readable (easy to debug)
- ✅ Version control friendly
- ✅ Simple backup/restore
- ✅ No database server needed
- ✅ Atomic writes (write to temp, then rename)
- ✅ Survives bot restarts

### 7. Discord Channel Strategy

**Confirmed Approach:**
- **One private thread per runner**
  - Named: `runner-{runnerId}` or custom name
  - Only owner + shared users can see
  - Shows runner status, active sessions

- **Sub-threads per CLI session** (within runner thread)
  - Named: `session-{sessionId}` or based on first task
  - Created when `/start-session` is called
  - All CLI output streams here
  - Interactive buttons for approvals

**Rationale:**
- Natural hierarchy (runner → sessions)
- Good permissions model (inherit from runner thread)
- Easy to navigate
- Discord supports 1000+ threads per channel

**Example:**
```
#sessions-channel
├── [Private Thread] runner-macbook-pro (User A's runner)
│   ├── Runner status: 🟢 Online
│   ├── Active sessions: 2
│   └── Sub-threads:
│       ├── [Thread] session-abc123 - "Fix auth bug"
│       └── [Thread] session-def456 - "Add tests"
│
└── [Private Thread] runner-linux-server (User A's 2nd runner)
    ├── Runner status: 🟢 Online
    ├── Active sessions: 0
    └── Sub-threads: (none)
```

### 8. Runner Crash Detection & Session Recovery

**Heartbeat Monitoring:**

```typescript
class HeartbeatMonitor {
  private interval = 30000; // 30 seconds
  private timeouts = new Map<string, NodeJS.Timeout>();

  startMonitoring(runnerId: string): void {
    // Expect heartbeat every 30s
    this.timeouts.set(runnerId, setTimeout(() => {
      this.handleRunnerTimeout(runnerId);
    }, this.interval * 2)); // 2x interval = timeout
  }

  recordHeartbeat(runnerId: string): void {
    // Reset timeout
    const timeout = this.timeouts.get(runnerId);
    if (timeout) clearTimeout(timeout);
    this.startMonitoring(runnerId);
  }

  private async handleRunnerTimeout(runnerId: string): void {
    const runner = await dataStore.getRunner(runnerId);
    if (!runner) return;

    // Mark as offline
    await dataStore.updateRunnerStatus(runnerId, 'offline');

    // Notify owner
    await discordBot.sendDM(runner.ownerId, {
      content: `⚠️ <@${runner.ownerId}> **Runner Offline**: \`${runner.name}\` (${runnerId})\n\n` +
               `Your runner has stopped responding. It may have crashed or lost connection.\n` +
               `Active sessions: ${runner.currentSessions}\n\n` +
               `Please check your runner and restart it if needed.`
    });

    // Update runner thread
    const runnerThread = await getRunnerThread(runnerId);
    await runnerThread.send({
      content: `⚠️ **Runner Offline**\n\n` +
               `Heartbeat lost. Please check the runner agent.`
    });

    // Handle active sessions
    const sessions = await dataStore.getSessionsByRunner(runnerId);
    for (const session of sessions.filter(s => s.status === 'active')) {
      await this.handleSessionCrash(session);
    }
  }

  private async handleSessionCrash(session: Session): Promise<void> {
    // Notify in session thread
    const sessionThread = await getSessionThread(session.threadId);
    await sessionThread.send({
      content: `⚠️ **Session Interrupted**\n\n` +
               `The runner has gone offline. What would you like to do?`,
      components: [
        {
          type: 'ActionRow',
          components: [
            {
              type: 'Button',
              label: 'Attempt Recovery',
              style: 'Primary',
              customId: `recover:${session.sessionId}`
            },
            {
              type: 'Button',
              label: 'Start Fresh',
              style: 'Secondary',
              customId: `fresh:${session.sessionId}`
            },
            {
              type: 'Button',
              label: 'Do Nothing',
              style: 'Danger',
              customId: `ignore:${session.sessionId}`
            }
          ]
        }
      ]
    });

    await dataStore.updateSession(session.sessionId, {
      status: 'interrupted',
      interruptedAt: new Date(),
      interruptReason: 'runner_offline'
    });
  }
}
```

**Session Recovery Options:**

When a runner comes back online:
1. **Attempt Recovery** - Try to resume session (if CLI supports it)
2. **Start Fresh** - Start new session with same working directory
3. **Do Nothing** - Leave session terminated

**Note:** Claude Code doesn't natively support session resume, so "Recovery" would mean:
- Start new Claude Code instance
- Try to restore context from transcript
- May not be perfect, but better than nothing

---

## Open Questions

### Resolved Questions

1. ✅ **Authentication**: Token-based system linking runners to Discord accounts
2. ✅ **Multi-user**: Built-in from day one with token system
3. ✅ **Session isolation**: Handled by Claude Code CLI
4. ✅ **Rate limiting**: Not needed, handled by Claude Code
5. ✅ **Output filtering**: Not needed, handled by Claude Code, private by default
6. ✅ **Persistent storage**: YAML-based file storage
7. ✅ **Channel structure**: Runner threads + session sub-threads
8. ✅ **Crash detection**: Heartbeat with @mention notifications

### Remaining Questions

1. ~~**CLI Interactive Prompts**~~ ← **RESOLVED - See Findings Below**
   - ~~How does Claude Code prompt for tool use approval?~~
   - ~~Can we detect and expose these as Discord buttons?~~

## 🎯 CRITICAL POC FINDING

### ❌ Cannot Parse Approval Prompts from Stdout

**Problem:** When using `--print` mode, Claude Code does NOT output approval prompts to stdout/stderr in a way we can detect and parse.

**Test Results:**
- ✅ Can spawn Claude Code
- ✅ Can capture output
- ✅ Can send input via stdin
- ❌ Cannot detect approval prompts (they don't appear in output)
- ❌ Permission prompts don't show in `--print` mode

### ✅ SOLUTION: Use Claude Code Hooks

**Approach:** Use Claude Code's official Hooks system instead of parsing output.

**How it works:**
```typescript
// Plugin: ~/.claude/plugins/discode/hooks.json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "*",  // All tools
      "hooks": [{
        "type": "command",
        "command": "node ~/.claude/plugins/discode/approval-handler.js"
      }]
    }]
  }
}
```

**Approval Handler:**
```javascript
// ~/.claude/plugins/discode/approval-handler.js
const hookInput = JSON.parse(require('fs').readFileSync(0, 'utf-8'));

// Extract tool info
const { tool_name, tool_input, session_id } = hookInput;

// Send to Runner Agent (via HTTP)
fetch('http://localhost:3000/approval', {
  method: 'POST',
  body: JSON.stringify({ toolName: tool_name, toolInput: tool_input })
})
.then(r => r.json())
.then(result => {
  // Return decision to Claude
  console.log(JSON.stringify({
    permissionDecision: result.allow ? 'allow' : 'deny',
    systemMessage: result.message
  }));
});
```

**Flow:**
```
User Prompt → Claude Code → PreToolUse Hook
                              ↓
                        Send HTTP to Runner Agent
                              ↓
                        WebSocket to Discord Bot
                              ↓
                        Show Buttons to User
                              ↓
                        User Clicks Button
                              ↓
                        Response → Runner Agent → Hook
                              ↓
                        Hook allows/denys tool use
                              ↓
                        Claude continues
```

**Benefits of Hooks Approach:**
- ✅ Structured data (no parsing needed)
- ✅ Official mechanism (won't break on updates)
- ✅ Full context (tool name, input, session info)
- ✅ Can modify tool inputs if needed
- ✅ Works for all interactive elements

**Trade-offs:**
- ⚠️  Requires plugin installation on each runner (one-time setup)
- ⚠️  Adds complexity to initial setup

### Updated Implementation Plan

**Phase 0: Plugin Development (NEW)** ⭐
1. Build Claude Code plugin for Discord integration
2. Test PreToolUse hook locally
3. Validate approval → Discord → response flow
4. Package plugin for easy installation

**Plugin Distribution:**
```bash
# Users run this to install
discode-setup --install-plugin

# Which installs:
~/.claude/plugins/discode/
├── hooks.json
├── approval-handler.js
└── package.json
```

**Runner Auto-Detection:**
```bash
# Runner agent checks for plugin on startup
if [ ! -d "$HOME/.claude/plugins/discode" ]; then
  echo "⚠️  DisCode plugin not installed"
  echo "Run: discode-setup --install-plugin"
  exit 1
fi
```

---

## Back to Original Content

---

## Additional Considerations

### Security

1. **Token Security**
   - Runners authenticate via unique tokens
   - Tokens stored hashed in database
   - Can be revoked anytime

2. **Session Isolation**
   - Each session in private thread
   - Only authorized users can access
   - File operations handled by Claude Code

3. **Discord Security**
   - Role-based permissions
   - Private threads by default
   - Audit logging in data.yaml

### Performance

1. **Output Batching**
   - Batch small output chunks
   - Reduce Discord API calls
   - Balance latency vs efficiency

2. **Resource Monitoring**
   - CPU, memory, disk per session
   - Kill sessions that exceed limits
   - Prevent runner crashes

3. **Load Balancing**
   - Distribute sessions across runners
   - Consider CLI type, system load
   - Prefer runner with existing session context

### Observability

1. **Logging**
   - Structured JSON logs
   - Log levels (DEBUG, INFO, WARN, ERROR)
   - Correlation IDs for requests

2. **Metrics**
   - Active sessions count
   - Runner health status
   - Message throughput
   - Error rates

3. **Tracing**
   - Request tracing backend → runner → CLI
   - Debug session issues
   - Performance profiling

### Deployment

1. **Docker Support**
   - Containerized backend
   - Containerized runners
   - Docker Compose for local dev

2. **Configuration**
   - Environment variables
   - Config file support
   - Default values + override

3. **Health Checks**
   - Backend health endpoint
   - Runner heartbeat
   - Automatic restart

---

## Next Steps

1. **Review this plan** with stakeholder(s)
2. **Clarify open questions** - especially authentication
3. **Build POC** - validate technical assumptions
4. **Iterate based on learnings** - adjust architecture as needed
5. **Start with MVP** - focus on core functionality first

---

## Appendix

### A. References

- [Claude Code Hooks Guide](https://medium.com/codebrainery/claude-code-hooks-transform-your-development-workflow-in-2025-caf6c93cbd5d)
- [Discord Gateway Documentation](https://discord.com/developers/docs/events/gateway)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [zebbern/claude-code-discord](https://github.com/zebbern/claude-code-discord)
- [sugyan/claude-code-webui](https://github.com/sugyan/claude-code-webui)
- [Node.js Child Process](https://nodejs.org/api/child_process.html)

### B. Example Output Parsing

```typescript
// Example: Parse Claude Code stream-json output
class ClaudeOutputParser {
  private buffer = '';

  parse(chunk: Buffer): ParsedOutput[] {
    this.buffer += chunk.toString();
    const outputs: ParsedOutput[] = [];
    const lines = this.buffer.split('\n');

    // Keep last incomplete line in buffer
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line);
        outputs.push(this.parseJSON(json));
      } catch {
        // Not JSON, treat as plain text
        outputs.push({
          type: 'text',
          content: line,
          timestamp: new Date().toISOString()
        });
      }
    }

    return outputs;
  }

  private parseJSON(json: any): ParsedOutput {
    // Detect type based on JSON structure
    if (json.type === 'tool_use') {
      return {
        type: 'tool_use',
        toolName: json.name,
        input: json.input,
        timestamp: json.timestamp
      };
    } else if (json.type === 'tool_result') {
      return {
        type: 'tool_result',
        toolName: json.tool_name,
        output: json.result,
        timestamp: json.timestamp
      };
    } else if (json.role === 'assistant') {
      return {
        type: 'assistant_message',
        content: json.message?.content || '',
        timestamp: json.timestamp
      };
    }

    // Fallback
    return {
      type: 'unknown',
      content: JSON.stringify(json),
      timestamp: new Date().toISOString()
    };
  }
}

interface ParsedOutput {
  type: 'assistant_message' | 'tool_use' | 'tool_result' | 'text' | 'error';
  content?: string;
  toolName?: string;
  input?: any;
  output?: any;
  timestamp: string;
}
```

### C. Example Discord Integration

```typescript
// Example: Discord bot with discord.js
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';

class DiscordBot {
  private client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent
    ]
  });

  async start() {
    await this.client.login(process.env.DISCORD_TOKEN);

    this.client.on('interactionCreate', async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const { commandName } = interaction;

      if (commandName === 'create-terminal') {
        await this.handleCreateTerminal(interaction);
      }
    });
  }

  private async handleCreateTerminal(interaction: ChatInputCommandInteraction) {
    const cliType = interaction.options.getString('cli-type');
    const projectPath = interaction.options.getString('project-path');

    // Create session
    const session = await this.sessionManager.createSession({
      cliType,
      projectPath,
      userId: interaction.user.id
    });

    // Create private thread
    const thread = await interaction.channel!.threads.create({
      name: `Session ${session.id}`,
      autoArchiveDuration: 60,
      type: ChannelType.PrivateThread
    });

    // Invite user
    await thread.members.add(interaction.user.id);

    await interaction.reply({
      content: `Created session: ${thread.toString()}`,
      ephemeral: true
    });
  }

  async streamOutput(sessionId: string, output: ParsedOutput) {
    const thread = await this.getSessionThread(sessionId);
    if (!thread) return;

    // Format output based on type
    const embed = this.formatOutput(output);

    await thread.send({ embeds: [embed] });
  }

  private formatOutput(output: ParsedOutput): EmbedBuilder {
    const embed = new EmbedBuilder()
      .setTimestamp(output.timestamp);

    switch (output.type) {
      case 'assistant_message':
        embed.setTitle('🤖 Claude Response')
          .setDescription(output.content?.substring(0, 4000))
          .setColor(0x5865F2);
        break;

      case 'tool_use':
        embed.setTitle(`🔧 Tool: ${output.toolName}`)
          .setDescription(JSON.stringify(output.input, null, 2))
          .setColor(0x57F287);
        break;

      case 'tool_result':
        embed.setTitle(`✅ Result: ${output.toolName}`)
          .setDescription(output.output?.substring(0, 4000))
          .setColor(0x5865F2);
        break;

      case 'error':
        embed.setTitle('❌ Error')
          .setDescription(output.content)
          .setColor(0xED4245);
        break;

      default:
        embed.setTitle('📝 Output')
          .setDescription(output.content)
          .setColor(0x5865F2);
    }

    return embed;
  }
}
```

---

**Document Version:** 1.0
**Last Updated:** 2025-01-15
**Status:** Planning Phase
