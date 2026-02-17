/**
 * Message Normalizer
 *
 * Handles transformation and normalization of messages from various CLI formats
 * (Claude, Codex, Gemini) into a unified format for Discord display.
 */

import type { NormalizedMessage } from './sync-types.js';

/**
 * Utility class for normalizing messages from different CLI formats
 */
export class MessageNormalizer {
    /**
     * Resolve the role (user/assistant) from raw message data
     */
    resolveMessageRole(rawMessage: any, messageObject: any, contentSource?: any): 'user' | 'assistant' {
        const roleCandidates = [
            rawMessage?.role,
            rawMessage?.type,
            messageObject?.role,
            messageObject?.type,
            rawMessage?.message?.role,
            contentSource?.role
        ];

        for (const candidate of roleCandidates) {
            if (candidate === 'user') return 'user';
            if (candidate === 'assistant' || candidate === 'gemini') return 'assistant';
        }

        return 'assistant';
    }

    /**
     * Extract content from various data structures
     */
    extractContentFromData(data: any): any | null {
        if (data == null) return null;

        if (typeof data === 'string') {
            return data.trim() ? data : null;
        }

        if (Array.isArray(data)) {
            return data.length > 0 ? data : null;
        }

        if (typeof data !== 'object') return null;

        // Skip progress messages
        if (typeof data.type === 'string' && data.type.includes('progress')) return null;
        if (typeof data.status === 'string' && typeof data.toolName === 'string') return null;

        if (typeof data.content === 'string' || Array.isArray(data.content)) {
            return data.content;
        }

        if (typeof data.text === 'string') {
            return [{ type: 'text', text: data.text }];
        }

        if (Array.isArray(data.blocks)) {
            return data.blocks;
        }

        if (typeof data.output === 'string') {
            return data.output;
        }

        if (typeof data.message === 'string') {
            return data.message;
        }

        return null;
    }

    /**
     * Normalize a raw message into a standard format
     */
    normalizeSyncedMessage(rawMessage: any): NormalizedMessage | null {
        if (!rawMessage) return null;

        const messageObject = rawMessage.message || rawMessage;
        const rawType = typeof rawMessage.type === 'string' ? rawMessage.type : '';
        const objectType = typeof messageObject?.type === 'string' ? messageObject.type : '';

        // Skip certain message types
        if (
            rawType === 'queue-operation' ||
            rawType === 'file-history-snapshot' ||
            objectType === 'queue-operation' ||
            objectType === 'file-history-snapshot' ||
            rawType === 'progress' ||
            objectType === 'progress' ||
            rawMessage?.isSnapshotUpdate ||
            rawMessage?.snapshot
        ) {
            return null;
        }

        // Extract content from various locations
        let content = messageObject?.content;
        if (content == null) {
            content = this.extractContentFromData(rawMessage?.data ?? messageObject?.data);
        }
        if (content == null) {
            content = this.extractContentFromData(rawMessage?.toolUseResult);
        }

        // Validate content
        if (content == null) return null;
        if (typeof content === 'string' && !content.trim()) return null;
        if (Array.isArray(content) && content.length === 0) return null;

        return {
            role: this.resolveMessageRole(rawMessage, messageObject, rawMessage?.data),
            content
        };
    }

    /**
     * Extract text from a content block
     */
    extractTextFromBlock(block: any): string | null {
        if (!block) return null;
        if (typeof block === 'string') return block.trim() ? block : null;
        if (typeof block.text === 'string') return block.text.trim() ? block.text : null;
        if (typeof block.content === 'string') return block.content.trim() ? block.content : null;
        return null;
    }

    /**
     * Convert a tool result block to text
     */
    toolResultToText(block: any): string {
        if (typeof block?.content === 'string') return block.content;
        if (Array.isArray(block?.content)) return block.content.map((entry: any) => entry?.text || JSON.stringify(entry)).join('\n');
        if (block?.content == null) return '';
        return JSON.stringify(block.content);
    }

    /**
     * Normalize an array of messages, filtering out invalid ones
     */
    normalizeMessages(messages: any[]): NormalizedMessage[] {
        return messages
            .map((msg) => this.normalizeSyncedMessage(msg))
            .filter((msg): msg is NormalizedMessage => msg !== null);
    }
}
