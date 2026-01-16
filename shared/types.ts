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
  cliType: 'claude' | 'gemini';
}

// Session-related types
export interface Session {
  sessionId: string;
  runnerId: string;
  channelId: string;
  threadId: string;
  createdAt: string;
  status: 'active' | 'ended';
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
  type: 'approval_request' | 'approval_response' | 'heartbeat' | 'session_start' | 'session_end' | 'output';
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
    timestamp: string;
  };
}

export interface OutputMessage extends WebSocketMessage {
  type: 'output';
  data: {
    runnerId: string;
    sessionId: string;
    content: string;
    timestamp: string;
  };
}
