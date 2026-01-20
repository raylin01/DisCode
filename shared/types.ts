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
}

// Session-related types
export interface Session {
  sessionId: string;
  runnerId: string;
  channelId: string;
  threadId: string;
  createdAt: string;
  status: 'active' | 'ended';
  cliType: 'claude' | 'gemini';
  folderPath?: string; // Optional custom working folder
  interactionToken?: string; // Token to update the ephemeral "Initializing" message
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
  type: 'approval_request' | 'approval_response' | 'heartbeat' | 'register' | 'session_start' | 'session_ready' | 'session_end' | 'output' | 'user_message' | 'list_terminals' | 'terminal_list' | 'watch_terminal' | 'session_discovered' | 'status' | 'action_item' | 'metadata';
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

export interface OutputMessage extends WebSocketMessage {
  type: 'output';
  data: {
    runnerId: string;
    sessionId: string;
    content: string;
    timestamp: string;
    outputType?: 'stdout' | 'stderr' | 'tool_use' | 'tool_result' | 'error';
  };
}

export interface SessionStartMessage extends WebSocketMessage {
  type: 'session_start';
  data: {
    sessionId: string;
    runnerId: string;
    cliType: 'claude' | 'gemini';
    folderPath?: string;
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
    timestamp: string;
  };
}
