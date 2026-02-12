/**
 * Shared types for DisCode system
 */
export interface DiscordUser {
    id: string;
    username: string;
    displayName: string;
}
export interface TokenInfo {
    token: string;
    userId: string;
    guildId: string;
    createdAt: string;
    lastUsed: string;
    isActive: boolean;
}
export interface RunnerConfig {
    threadArchiveDays?: number;
    autoSync?: boolean;
    thinkingLevel?: 'high' | 'medium' | 'low';
    yoloMode?: boolean;
}
export interface RunnerInfo {
    runnerId: string;
    name: string;
    ownerId: string;
    token: string;
    status: 'online' | 'offline';
    lastHeartbeat: string;
    authorizedUsers: string[];
    cliTypes: ('claude' | 'gemini')[];
    privateChannelId?: string;
    defaultWorkspace?: string;
    assistantEnabled?: boolean;
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
        projects?: Record<string, {
            channelId: string;
            lastSync?: string;
        }>;
        sessions?: Record<string, {
            threadId: string;
            projectPath: string;
            lastSync?: string;
        }>;
    };
}
export interface Session {
    sessionId: string;
    runnerId: string;
    channelId: string;
    threadId: string;
    createdAt: string;
    status: 'active' | 'ended';
    cliType: 'claude' | 'gemini' | 'generic';
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk';
    folderPath?: string;
    interactionToken?: string;
    creatorId?: string;
}
export interface Attachment {
    name: string;
    url: string;
    contentType?: string;
    size?: number;
}
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
export interface WebSocketMessage {
    type: 'approval_request' | 'approval_response' | 'heartbeat' | 'register' | 'session_start' | 'session_ready' | 'session_end' | 'output' | 'user_message' | 'list_terminals' | 'terminal_list' | 'watch_terminal' | 'session_discovered' | 'sync_session_discovered' | 'sync_session_updated' | 'status' | 'action_item' | 'metadata' | 'discord_action' | 'assistant_message' | 'assistant_output' | 'spawn_thread' | 'tool_execution' | 'tool_result' | 'result' | 'sync_projects' | 'sync_projects_response' | 'sync_sessions' | 'sync_sessions_response' | 'permission_decision' | 'permission_decision_ack';
    data: unknown;
}
export interface SyncProjectsMessage extends WebSocketMessage {
    type: 'sync_projects';
    data: {
        runnerId: string;
    };
}
export interface SyncProjectsResponseMessage extends WebSocketMessage {
    type: 'sync_projects_response';
    data: {
        runnerId: string;
        projects: {
            path: string;
            lastModified: string;
            sessionCount: number;
        }[];
    };
}
export interface SyncSessionsMessage extends WebSocketMessage {
    type: 'sync_sessions';
    data: {
        runnerId: string;
        projectPath: string;
    };
}
export interface SyncSessionsResponseMessage extends WebSocketMessage {
    type: 'sync_sessions_response';
    data: {
        runnerId: string;
        projectPath: string;
        sessions: {
            sessionId: string;
            projectPath: string;
            firstPrompt: string;
            created: string;
            messageCount: number;
            gitBranch?: string;
            messages?: any[];
        }[];
    };
}
export interface SyncSessionDiscoveredMessage extends WebSocketMessage {
    type: 'sync_session_discovered';
    data: {
        runnerId: string;
        session: {
            sessionId: string;
            projectPath: string;
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
            messageCount: number;
        };
        newMessages: any[];
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
        options?: string[];
        isMultiSelect?: boolean;
        hasOther?: boolean;
        suggestions?: unknown[];
        blockedPath?: string;
        decisionReason?: string;
        timestamp: string;
    };
}
export interface ApprovalResponseMessage extends WebSocketMessage {
    type: 'approval_response';
    data: {
        requestId?: string;
        sessionId?: string;
        allow?: boolean;
        message?: string;
        modifiedToolInput?: unknown;
        approved?: boolean;
        optionNumber?: string;
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
