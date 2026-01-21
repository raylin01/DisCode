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
    userId: string;
    channelId: string;
    messageId: string;
    runnerId: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
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
}
export const streamingMessages = new Map<string, StreamingMessage>();

// Session creation state (userId -> creation wizard state)
export interface SessionCreationState {
    step: 'select_runner' | 'select_cli' | 'select_plugin' | 'select_folder' | 'complete';
    runnerId?: string;
    cliType?: 'claude' | 'gemini' | 'terminal';
    plugin?: 'tmux' | 'print' | 'stream';
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

