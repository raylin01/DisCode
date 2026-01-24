/**
 * Shared types for DisCode system
 */

// Discord-related types
export interface DiscordUser {
  id: string;
  username: string;
  displayName: string;
}

// Token authentication
export interface TokenInfo {
  token: string;
  userId: string;
  guildId: string;
  createdAt: string;
  lastUsed: string;
  isActive: boolean;
}

// Runner-related types
export interface RunnerInfo {
  runnerId: string;
  name: string;
  ownerId: string;
  token: string;
  status: 'online' | 'offline';
  lastHeartbeat: string;
  authorizedUsers: string[];
  cliTypes: ('claude' | 'gemini')[];
  privateChannelId?: string; // ID of the private channel for this runner
  defaultWorkspace?: string;
  assistantEnabled?: boolean;  // Whether assistant is enabled for this runner
}

// Session-related types
export interface Session {
  sessionId: string;
  runnerId: string;
  channelId: string;
  threadId: string;
  createdAt: string;
  status: 'active' | 'ended';
  cliType: 'claude' | 'gemini' | 'generic';
  folderPath?: string; // Optional custom working folder
  interactionToken?: string; // Token to update the ephemeral "Initializing" message
  creatorId?: string; // ID of the user who created the session
}

export interface Attachment {
  name: string;
  url: string;
  contentType?: string;
  size?: number;
}

// Approval requests
export interface ApprovalRequest {
  toolName: string;
  toolInput: unknown;
  sessionId: string;
  timestamp: string;
  cli?: 'claude' | 'gemini';
  runnerId?: string;
}

export interface ApprovalResponse {
  allow: boolean;
  message?: string;
  modifiedToolInput?: unknown;
}

// WebSocket messages
export interface WebSocketMessage {
  type: 'approval_request' | 'approval_response' | 'heartbeat' | 'register' | 'session_start' | 'session_ready' | 'session_end' | 'output' | 'user_message' | 'list_terminals' | 'terminal_list' | 'watch_terminal' | 'session_discovered' | 'status' | 'action_item' | 'metadata' | 'discord_action' | 'assistant_message' | 'assistant_output' | 'spawn_thread';
  data: unknown;
}

export interface ApprovalRequestMessage extends WebSocketMessage {
  type: 'approval_request';
  data: {
    requestId: string;
    runnerId: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    timestamp: string;
  };
}

export interface ApprovalResponseMessage extends WebSocketMessage {
  type: 'approval_response';
  data: {
    requestId: string;
    allow: boolean;
    message?: string;
  };
}

export interface HeartbeatMessage extends WebSocketMessage {
  type: 'heartbeat';
  data: {
    runnerId: string;
    runnerName?: string;
    cliTypes?: ('claude' | 'gemini')[];
    defaultWorkspace?: string;
    timestamp: string;
  };
}

export interface RegisterMessage extends WebSocketMessage {
  type: 'register';
  data: {
    runnerName: string;
    token: string;
    cliTypes: ('claude' | 'gemini')[];
    defaultWorkspace?: string;
  };
}

// Structured data for rich output formatting
export interface StructuredData {
  edit?: {
    filePath: string;
    oldContent?: string;
    newContent?: string;
    diff?: string;
  };
  tool?: {
    name: string;
    input: Record<string, any>;
  };
}

export interface OutputMessage extends WebSocketMessage {
  type: 'output';
  data: {
    runnerId: string;
    sessionId: string;
    content: string;
    timestamp: string;
    outputType?: 'stdout' | 'stderr' | 'info' | 'thinking' | 'edit' | 'tool_use' | 'tool_result' | 'error';
    isComplete?: boolean;
    structuredData?: StructuredData;
  };
}

export interface SessionStartMessage extends WebSocketMessage {
  type: 'session_start';
  data: {
    sessionId: string;
    runnerId: string;
    cliType: 'claude' | 'gemini';
    folderPath?: string;
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk';
  };
}

export interface SessionReadyMessage extends WebSocketMessage {
  type: 'session_ready';
  data: {
    sessionId: string;
    runnerId: string;
  };
}

export interface SessionEndMessage extends WebSocketMessage {
  type: 'session_end';
  data: {
    sessionId: string;
  };
}

export interface UserMessage extends WebSocketMessage {
  type: 'user_message';
  data: {
    sessionId: string;
    userId: string;
    username: string;
    content: string;
    attachments?: Attachment[];
    timestamp: string;
  };
}

// Assistant-specific messages
export interface AssistantMessageWS extends WebSocketMessage {
  type: 'assistant_message';
  data: {
    runnerId: string;
    userId: string;
    username: string;
    content: string;
    timestamp: string;
  };
}

export interface AssistantOutputMessage extends WebSocketMessage {
  type: 'assistant_output';
  data: {
    runnerId: string;
    content: string;
    timestamp: string;
    outputType?: 'stdout' | 'stderr' | 'tool_use' | 'tool_result' | 'error';
  };
}

export interface SpawnThreadMessage extends WebSocketMessage {
  type: 'spawn_thread';
  data: {
    runnerId: string;
    folder: string;
    cliType?: 'claude' | 'gemini' | 'auto';
    initialMessage?: string;
  };
}
