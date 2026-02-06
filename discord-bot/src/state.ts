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

// Pending approvals (requestId -> approval info)
export interface PendingApproval {
    userId?: string;
    channelId: string;
    messageId: string;
    runnerId: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    requestId?: string;
    timestamp?: Date;
    // Multi-select and Other option support for AskUserQuestion
    options?: string[]; // Available options
    isMultiSelect?: boolean; // Whether this is a multi-select question
    hasOther?: boolean; // Whether this has an "Other" option
}
export const pendingApprovals = new Map<string, PendingApproval>();

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
    cliType?: 'claude' | 'gemini' | 'terminal';
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk';
    folder?: string; // Pre-selected folder (for "New Session" button)
    folderPath?: string;
    options?: {
        approvalMode?: 'manual' | 'auto';
    };
    messageId?: string;
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
