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
export interface RunnerConfig {
  threadArchiveDays?: number; // 3, 7, 30, or -1 (never)
  autoSync?: boolean;
  thinkingLevel?: 'high' | 'medium' | 'low';
  yoloMode?: boolean; // If true, auto-approve commands
  claudeDefaults?: Record<string, any>;
  codexDefaults?: Record<string, any>;
  geminiDefaults?: Record<string, any>;
  presets?: Record<string, any>;
}

export interface RunnerInfo {
  runnerId: string;
  name: string;
  ownerId: string;
  token: string;
  status: 'online' | 'offline';
  lastHeartbeat: string;
  authorizedUsers: string[];
  cliTypes: ('claude' | 'gemini' | 'codex')[];
  privateChannelId?: string; // ID of the private channel for this runner
  defaultWorkspace?: string;
  assistantEnabled?: boolean;  // Whether assistant is enabled for this runner
  systemStats?: {
    cpu?: number;
    memory?: number;
    uptime?: number;
  };
  platform?: string;
  arch?: string;
  hostname?: string;
  config?: RunnerConfig;
  discordState?: {
    categoryId?: string;
    controlChannelId?: string;
    statsChannelIds?: {
      sessions?: string;
      pending?: string;
    };
    projects?: Record<string, { channelId: string; lastSync?: string; dashboardMessageId?: string }>;
    // Persist session->thread mapping to prevent duplicates on restart
    sessions?: Record<string, { threadId: string; projectPath: string; lastSync?: string; cliType?: 'claude' | 'codex' }>;
  };
}

// Session-related types
export interface Session {
  sessionId: string;
  runnerId: string;
  channelId: string;
  threadId: string;
  createdAt: string;
  status: 'active' | 'ended';
  cliType: 'claude' | 'gemini' | 'codex' | 'generic';
  plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk'; // Plugin type used for this session
  folderPath?: string; // Optional custom working folder
  interactionToken?: string; // Token to update the ephemeral "Initializing" message
  creatorId?: string; // ID of the user who created the session
  options?: Record<string, any>; // Session-specific options
  settingsMessageId?: string; // Latest settings summary message ID
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
  type: 'approval_request' | 'approval_response' | 'heartbeat' | 'register' | 'session_start' | 'session_ready' | 'session_end' | 'output' | 'user_message' | 'list_terminals' | 'terminal_list' | 'watch_terminal' | 'session_discovered' | 'sync_session_discovered' | 'sync_session_updated' | 'status' | 'action_item' | 'metadata' | 'discord_action' | 'assistant_message' | 'assistant_output' | 'spawn_thread' | 'tool_execution' | 'tool_result' | 'result' | 'sync_projects' | 'sync_projects_response' | 'sync_projects_progress' | 'sync_projects_complete' | 'sync_sessions' | 'sync_sessions_response' | 'sync_sessions_complete' | 'sync_status_request' | 'sync_status_response' | 'permission_decision' | 'permission_decision_ack' | 'permission_sync_request' | 'session_control' | 'sync_session_messages' | 'runner_config_update' | 'runner_config_updated' | 'runner_health_request' | 'runner_health_response' | 'runner_logs_request' | 'runner_logs_response' | 'codex_thread_list_request' | 'codex_thread_list_response' | 'model_list_request' | 'model_list_response';
  data: unknown;
}

export interface CodexThreadListRequest extends WebSocketMessage {
  type: 'codex_thread_list_request';
  data: {
    runnerId: string;
    requestId?: string;
    cursor?: string | null;
    limit?: number | null;
    sortKey?: 'created_at' | 'updated_at' | null;
    archived?: boolean | null;
  };
}

export interface CodexThreadListResponse extends WebSocketMessage {
  type: 'codex_thread_list_response';
  data: {
    runnerId: string;
    requestId?: string;
    threads?: Array<{
      id: string;
      preview?: string;
      cwd?: string;
      updatedAt?: number;
      createdAt?: number;
      modelProvider?: string;
      path?: string | null;
    }>;
    nextCursor?: string | null;
    error?: string;
  };
}

export interface RunnerModelInfo {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

export interface ModelListRequest extends WebSocketMessage {
  type: 'model_list_request';
  data: {
    runnerId: string;
    cliType: 'claude' | 'codex';
    requestId?: string;
    cursor?: string | null;
    limit?: number | null;
  };
}

export interface ModelListResponse extends WebSocketMessage {
  type: 'model_list_response';
  data: {
    runnerId: string;
    cliType: 'claude' | 'codex';
    requestId?: string;
    models?: RunnerModelInfo[];
    defaultModel?: string | null;
    nextCursor?: string | null;
    error?: string;
  };
}

export interface SyncProjectsMessage extends WebSocketMessage {
    type: 'sync_projects';
    data: {
        runnerId: string;
    requestId?: string;
    };
}

export interface SyncProjectsResponseMessage extends WebSocketMessage {
    type: 'sync_projects_response';
    data: {
        runnerId: string;
    requestId?: string;
        projects: {
            path: string;
            lastModified: string;
            sessionCount: number;
        }[];
    };
}

export interface SyncProjectsProgressMessage extends WebSocketMessage {
  type: 'sync_projects_progress';
  data: {
    runnerId: string;
    requestId?: string;
    phase: 'listing' | 'sessions' | 'watching';
    completed: number;
    total?: number;
    projectPath?: string;
    message?: string;
    timestamp: string;
  };
}

export interface SyncProjectsCompleteMessage extends WebSocketMessage {
  type: 'sync_projects_complete';
  data: {
    runnerId: string;
    requestId?: string;
    projects: {
      path: string;
      lastModified: string;
      sessionCount: number;
    }[];
    status: 'success' | 'error';
    error?: string;
    startedAt: string;
    completedAt: string;
  };
}

export interface SyncSessionsMessage extends WebSocketMessage {
    type: 'sync_sessions';
    data: {
        runnerId: string;
        projectPath: string;
    requestId?: string;
    };
}

export interface SyncSessionsResponseMessage extends WebSocketMessage {
    type: 'sync_sessions_response';
    data: {
        runnerId: string;
        projectPath: string;
    requestId?: string;
        sessions: {
            sessionId: string;
            projectPath: string;
            cliType?: 'claude' | 'codex';
            firstPrompt: string;
            created: string;
            messageCount: number;
            gitBranch?: string;
            messages?: any[];
        }[];
    };
}

export interface SyncSessionsCompleteMessage extends WebSocketMessage {
  type: 'sync_sessions_complete';
  data: {
    runnerId: string;
    projectPath: string;
    requestId?: string;
    status: 'success' | 'error';
    error?: string;
    startedAt: string;
    completedAt: string;
    sessionCount: number;
  };
}

export interface SyncSessionMessagesMessage extends WebSocketMessage {
  type: 'sync_session_messages';
  data: {
    runnerId: string;
    sessionId: string;
    projectPath: string;
    cliType?: 'claude' | 'codex';
    requestId?: string;
  };
}

export interface SyncStatusRequestMessage extends WebSocketMessage {
  type: 'sync_status_request';
  data: {
    runnerId: string;
    requestId: string;
  };
}

export interface SyncStatusResponseMessage extends WebSocketMessage {
  type: 'sync_status_response';
  data: {
    runnerId: string;
    requestId: string;
    status: {
      state: 'idle' | 'syncing' | 'error';
      lastSyncAt?: string;
      lastError?: string;
      projects: Record<string, {
        projectPath: string;
        state: 'idle' | 'syncing' | 'complete' | 'error';
        lastSyncAt?: string;
        lastError?: string;
        sessionCount?: number;
      }>;
    };
  };
}

export interface SessionControlMessage extends WebSocketMessage {
  type: 'session_control';
  data: {
    runnerId: string;
    sessionId: string;
    action: 'set_model' | 'set_permission_mode' | 'set_max_thinking_tokens';
    value: string | number;
  };
}

export interface SyncSessionDiscoveredMessage extends WebSocketMessage {
    type: 'sync_session_discovered';
    data: {
        runnerId: string;
        session: {
            sessionId: string;
            projectPath: string;
            cliType?: 'claude' | 'codex';
            firstPrompt: string;
            created: string;
            messageCount: number;
            gitBranch?: string;
            messages?: any[];
        };
    };
}

export interface SyncSessionUpdatedMessage extends WebSocketMessage {
    type: 'sync_session_updated';
    data: {
        runnerId: string;
        session: {
            sessionId: string;
            projectPath: string;
            cliType?: 'claude' | 'codex';
            messageCount: number;
        };
        newMessages: any[]; // The new messages to post
    };
}

export interface ApprovalRequestMessage extends WebSocketMessage {
  type: 'approval_request';
  data: {
    requestId: string;
    runnerId: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    options?: string[];  // Available options for AskUserQuestion
    isMultiSelect?: boolean;  // Whether multiple options can be selected
    hasOther?: boolean;  // Whether to show "Other..." button for custom input
    suggestions?: unknown[];  // Permission suggestions (for scoped allow)
    blockedPath?: string;
    decisionReason?: string;
    timestamp: string;
  };
}

export interface ApprovalResponseMessage extends WebSocketMessage {
  type: 'approval_response';
  data: {
    // Tool approval format
    requestId?: string;
    sessionId?: string;
    allow?: boolean;
    message?: string;
    modifiedToolInput?: unknown;
    // AskUserQuestion format
    approved?: boolean;
    optionNumber?: string;  // Comma-separated for multi-select (e.g., "1,2,3")
  };
}

export interface PermissionDecisionMessage extends WebSocketMessage {
  type: 'permission_decision';
  data: {
    requestId: string;
    sessionId: string;
    behavior: 'allow' | 'deny';
    scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
    updatedPermissions?: unknown[];
    customMessage?: string;
  };
}

export interface PermissionDecisionAckMessage extends WebSocketMessage {
  type: 'permission_decision_ack';
  data: {
    requestId: string;
    sessionId: string;
    success: boolean;
    error?: string;
    timestamp: string;
  };
}

export interface PermissionSyncRequestMessage extends WebSocketMessage {
  type: 'permission_sync_request';
  data: {
    runnerId?: string;
    requestId?: string;
    sessionId?: string;
    reason?: string;
  };
}

export interface HeartbeatMessage extends WebSocketMessage {
  type: 'heartbeat';
  data: {
    runnerId: string;
    runnerName?: string;
    cliTypes?: ('claude' | 'gemini' | 'codex')[];
    defaultWorkspace?: string;
    timestamp: string;
  };
}

export interface RegisterMessage extends WebSocketMessage {
  type: 'register';
  data: {
    runnerName: string;
    token: string;
    cliTypes: ('claude' | 'gemini' | 'codex')[];
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
    result?: string;
    isError?: boolean;
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
    cliType: 'claude' | 'gemini' | 'codex' | 'terminal' | 'generic';
    folderPath?: string;
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk';
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

export interface ResultWSMessage extends WebSocketMessage {
  type: 'result';
  data: {
    runnerId: string;
    sessionId: string;
    result: string;
    subtype: 'success' | 'error';
    durationMs: number;
    durationApiMs: number;
    numTurns: number;
    isError: boolean;
    error?: string;
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
