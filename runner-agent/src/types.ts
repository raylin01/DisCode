/**
 * Local Type Definitions for Runner Agent
 */

export interface SessionMetadata {
    sessionId: string;
    cliType: 'claude' | 'gemini' | 'codex' | 'terminal' | 'generic';
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk';
    folderPath?: string;
    runnerId: string;
}

export interface PendingApproval {
    resolve: (response: { allow: boolean; message?: string }) => void;
    reject: (error: Error) => void;
}

export interface PendingApprovalRequestInfo {
    requestId: string;
    runnerId: string;
    sessionId: string;
    origin?: 'native' | 'sync_attached';
    toolName: string;
    toolInput: unknown;
    options?: string[];
    isMultiSelect?: boolean;
    hasOther?: boolean;
    suggestions?: unknown[];
    blockedPath?: string;
    decisionReason?: string;
    timestamp: string;
    firstSeenAt: number;
    lastSentAt: number;
    resendCount: number;
}

export interface PendingMessage {
    userId: string;
    username: string;
    content: string;
    timestamp: string;
}

// CLI path storage
export type CliPaths = Record<'claude' | 'gemini' | 'codex', string | null>;
