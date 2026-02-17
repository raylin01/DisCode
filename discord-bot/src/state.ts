/**
 * Discord Bot State
 * 
 * Shared state containers used across handlers.
 */

import { Client, GatewayIntentBits } from 'discord.js';

// Discord client singleton
export const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// Track if bot is ready
export let isBotReady = false;
export function setBotReady(ready: boolean): void {
    isBotReady = ready;
}

// Active WebSocket connections (runnerId -> ws)
export const runnerConnections = new Map<string, any>();


// Pending approvals now use unified permissionStateStore (see permissions/state-store.ts)


// Allowed tools per session (sessionId -> Set of toolNames that are auto-approved)
export const allowedTools = new Map<string, Set<string>>();

// Action items extracted from sessions (sessionId -> actionItems)
export const actionItems = new Map<string, string[]>();

// Streaming message tracker (sessionId -> message state)
export interface StreamingMessage {
    messageId: string;
    lastUpdateTime: number;
    content: string;
    outputType: string;
    accumulatedContent?: string; // Tracks the full accumulated content for the message
}
export const streamingMessages = new Map<string, StreamingMessage>();

// Session creation state (userId -> creation wizard state)
export interface SessionCreationState {
    step: 'select_runner' | 'select_cli' | 'select_plugin' | 'select_folder' | 'complete';
    runnerId?: string;
    cliType?: 'claude' | 'gemini' | 'codex' | 'terminal';
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk';
    folder?: string; // Pre-selected folder (for "New Session" button)
    folderPath?: string;
    options?: {
        approvalMode?: 'manual' | 'autoSafe' | 'auto';
        skipPermissions?: boolean;
        thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' | 'default_on';
        maxThinkingTokens?: number;
        maxTurns?: number;
        maxBudgetUsd?: number;
        model?: string;
        fallbackModel?: string;
        agent?: string;
        permissionMode?: 'default' | 'acceptEdits';
        [key: string]: any;
    };
    messageId?: string;
    projectChannelId?: string;
}
export const sessionCreationState = new Map<string, SessionCreationState>();

// Session status tracker (sessionId -> status)
export type SessionStatus = 'idle' | 'working' | 'waiting' | 'offline' | 'error';
export const sessionStatuses = new Map<string, SessionStatus>();

// Pending terminal list requests (runnerId -> interaction info)
export interface PendingTerminalListRequest {
    interactionToken: string;
    applicationId: string;
    runnerName: string;
    requestedAt: number;
}
export const pendingTerminalListRequests = new Map<string, PendingTerminalListRequest>();

// Assistant streaming messages tracker (runnerId -> message state)
export const assistantStreamingMessages = new Map<string, StreamingMessage>();

// Multi-select question state (requestId -> multi-select state)
export interface MultiSelectState {
    requestId: string;
    sessionId: string;
    runnerId: string;
    selectedOptions: Set<string>; // Set of selected option numbers
    options: string[]; // All available options
    isMultiSelect: boolean;
    hasOther: boolean;
    toolName: string;
    timestamp: Date;
}
export const multiSelectState = new Map<string, MultiSelectState>();

// User scope preference (userId -> scope)
export type UserScope = 'session' | 'project' | 'global';
export const userScopePreferences = new Map<string, UserScope>();

// Pending permission confirmations (requestId -> confirmation state)
export interface PendingPermissionConfirmation {
    requestId: string;
    interaction: any;
    userId: string;
    username: string;
    toolName: string;
    behavior: 'allow' | 'deny';
    scope?: string;
    timeout: NodeJS.Timeout;
}
export const pendingPermissionConfirmations = new Map<string, PendingPermissionConfirmation>();

// Pending runner config updates (requestId -> timeout)
export const pendingRunnerConfigUpdates = new Map<string, NodeJS.Timeout>();

export const pendingRunnerHealthRequests = new Map<string, { resolve: (data: any | null) => void; timeout: NodeJS.Timeout }>();
export const pendingRunnerLogsRequests = new Map<string, { resolve: (data: any | null) => void; timeout: NodeJS.Timeout }>();
export const pendingCodexThreadListRequests = new Map<string, { resolve: (data: any | null) => void; timeout: NodeJS.Timeout }>();
export const pendingModelListRequests = new Map<string, { resolve: (data: any | null) => void; timeout: NodeJS.Timeout }>();

export interface RunnerModelCacheEntry {
    runnerId: string;
    cliType: 'claude' | 'codex';
    models: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>;
    defaultModel?: string | null;
    nextCursor?: string | null;
    fetchedAt: number;
}
export const runnerModelCache = new Map<string, RunnerModelCacheEntry>();

export const codexThreadCache = new Map<string, { runnerId: string; cwd?: string; preview?: string; updatedAt?: number; createdAt?: number; lastSeen: number }>();

// One-shot suppression for reconnect reattach flows (sessionId -> suppress next session_ready post)
export const suppressSessionReadyNotification = new Set<string>();

// Track sessions that have already received "Session Ready" notification (to prevent duplicate pings)
export const sessionReadyNotified = new Set<string>();

// Pending attach-to-approve fallback notices (sessionId -> timeout + target thread)
export const pendingSyncedAttachFallbacks = new Map<string, { threadId: string; timeout: NodeJS.Timeout }>();

// Runner memory tracking (runnerId -> memory in MB)
export const runnerMemoryUsage = new Map<string, number>();
