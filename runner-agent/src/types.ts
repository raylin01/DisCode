/**
 * Local Type Definitions for Runner Agent
 */

export interface SessionMetadata {
    sessionId: string;
    cliType: 'claude' | 'gemini' | 'terminal' | 'generic';
    plugin?: 'tmux' | 'print' | 'stream' | 'claude-sdk';
    folderPath?: string;
    runnerId: string;
}

export interface PendingApproval {
    resolve: (response: { allow: boolean; message?: string }) => void;
    reject: (error: Error) => void;
}

export interface PendingMessage {
    userId: string;
    username: string;
    content: string;
    timestamp: string;
}

// CLI path storage
export type CliPaths = Record<'claude' | 'gemini', string | null>;
