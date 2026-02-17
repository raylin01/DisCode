/**
 * Shared utilities and types for sync services
 */

import path from 'path';
import {
    SyncedContentBlock,
    SyncedSessionMessage
} from '../../../shared/types.js';

// Re-export types for convenience
export type { SyncedContentBlock, SyncedSessionMessage };
export type CliType = 'claude' | 'codex' | 'gemini';

/**
 * Normalize a project path to its absolute resolved form
 */
export function normalizeProjectPath(projectPath: string): string {
    if (!projectPath || typeof projectPath !== 'string') return projectPath;
    return path.resolve(projectPath);
}

/**
 * Create a sync session key from sessionId and cliType
 */
export function toSyncSessionKey(sessionId: string, cliType: CliType = 'claude'): string {
    return `${cliType}:${sessionId}`;
}

/**
 * Convert various timestamp formats to ISO string
 */
export function toIsoTimestamp(value: unknown): string {
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
    }
    if (typeof value === 'number') {
        const ms = value > 1_000_000_000_000 ? value : value * 1000;
        return new Date(ms).toISOString();
    }
    return new Date().toISOString();
}

/**
 * Safely stringify a value to JSON with max character limit
 */
export function safeJson(value: unknown, maxChars = 1500): string {
    try {
        const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return raw.length > maxChars ? `${raw.slice(0, maxChars)}...` : raw;
    } catch {
        return String(value);
    }
}

/**
 * Build a structured message for sync protocol
 */
export function buildStructuredMessage(
    role: 'user' | 'assistant',
    createdAt: string,
    turnId: string,
    itemId: string,
    blockIndex: number,
    block: SyncedContentBlock
): SyncedSessionMessage {
    return {
        id: `${turnId}:${itemId}:${blockIndex}`,
        role,
        createdAt,
        turnId,
        itemId,
        content: [block]
    };
}

/**
 * Collect text from user input content blocks
 */
export function collectTextFromUserInputs(content: any[]): string[] {
    const texts: string[] = [];
    for (const entry of content) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.type === 'text' && typeof entry.text === 'string' && entry.text.trim()) {
            texts.push(entry.text.trim());
        } else if (typeof (entry as any).text === 'string' && (entry as any).text.trim()) {
            texts.push((entry as any).text.trim());
        }
    }
    return texts;
}
