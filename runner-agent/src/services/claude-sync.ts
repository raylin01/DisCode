/**
 * Claude-specific sync logic
 * Handles extraction and transformation of Claude session messages
 */

import {
    getSessionDetailsAsync
} from '@raylin01/claude-client/sessions';
import {
    SyncedContentBlock,
    SyncedSessionMessage,
    safeJson,
    toIsoTimestamp,
    buildStructuredMessage
} from './sync-utils.js';

/**
 * Extract text from a Claude content block
 */
export function extractClaudeTextBlock(block: any): string | null {
    if (!block) return null;
    if (typeof block?.text === 'string' && block.text.trim()) return block.text.trim();
    if (typeof block?.content === 'string' && block.content.trim()) return block.content.trim();
    return null;
}

/**
 * Format Claude todos into a readable string
 */
export function formatClaudeTodos(todos: any[]): string | null {
    if (!Array.isArray(todos) || todos.length === 0) return null;

    const lines = todos.slice(0, 20).map((todo: any) => {
        const status = typeof todo?.status === 'string' ? todo.status : 'pending';
        const content = typeof todo?.content === 'string'
            ? todo.content
            : (typeof todo?.title === 'string' ? todo.title : 'Untitled');
        return `- [${status}] ${content}`;
    });

    if (todos.length > 20) {
        lines.push(`- ...and ${todos.length - 20} more`);
    }

    return lines.join('\n').trim() || null;
}

/**
 * Extract structured messages from Claude raw session messages
 */
export function extractClaudeStructuredMessages(rawMessages: any[]): SyncedSessionMessage[] {
    const messages: SyncedSessionMessage[] = [];
    const resolvedToolUseIds = new Set<string>();
    const pendingToolUses = new Map<string, {
        turnId: string;
        itemId: string;
        createdAt: string;
        toolName?: string;
        input?: unknown;
        messageIndex: number;
    }>();

    // First pass: collect all resolved tool_use_ids
    for (const raw of rawMessages) {
        const content = Array.isArray(raw?.message?.content) ? raw.message.content : [];
        for (const block of content) {
            if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string' && block.tool_use_id.trim()) {
                resolvedToolUseIds.add(block.tool_use_id);
            }
        }
    }

    // Second pass: extract messages
    rawMessages.forEach((raw, index) => {
        const rawType = typeof raw?.type === 'string' ? raw.type : '';
        if (
            rawType === 'queue-operation' ||
            rawType === 'file-history-snapshot' ||
            raw?.isSnapshotUpdate ||
            raw?.snapshot
        ) {
            return;
        }

        const role: 'user' | 'assistant' = raw?.message?.role === 'user' || rawType === 'user' ? 'user' : 'assistant';
        const createdAt = toIsoTimestamp(raw?.timestamp ?? Date.now());
        const turnId = `claude-${raw?.sessionId || 'session'}`;
        const itemId = typeof raw?.uuid === 'string' && raw.uuid.trim() ? raw.uuid : `line-${index}`;
        const blocks: SyncedContentBlock[] = [];

        // Handle summary type
        if (rawType === 'summary' && typeof raw?.summary === 'string' && raw.summary.trim()) {
            blocks.push({ type: 'text', text: raw.summary.trim() });
        }

        // Process content blocks
        const content = Array.isArray(raw?.message?.content) ? raw.message.content : [];
        for (const block of content) {
            const blockType = typeof block?.type === 'string' ? block.type : 'unknown';

            // Text blocks
            if (blockType === 'text' || blockType === 'input_text' || blockType === 'output_text' || blockType === 'inputText') {
                const text = extractClaudeTextBlock(block);
                if (text) blocks.push({ type: 'text', text });
                continue;
            }

            // Thinking blocks
            if (blockType === 'thinking' && typeof block?.thinking === 'string' && block.thinking.trim()) {
                blocks.push({ type: 'thinking', thinking: block.thinking.trim() });
                continue;
            }

            // Tool use blocks
            if (blockType === 'tool_use') {
                const toolUseId = typeof block?.id === 'string' && block.id.trim() ? block.id : undefined;
                const toolName = typeof block?.name === 'string' && block.name.trim() ? block.name : 'ToolUse';
                blocks.push({
                    type: 'tool_use',
                    name: toolName,
                    input: block?.input,
                    toolUseId
                });
                if (toolUseId && !resolvedToolUseIds.has(toolUseId)) {
                    pendingToolUses.set(toolUseId, {
                        turnId,
                        itemId,
                        createdAt,
                        toolName,
                        input: block?.input,
                        messageIndex: index
                    });
                }
                continue;
            }

            // Tool result blocks
            if (blockType === 'tool_result') {
                const toolUseId = typeof block?.tool_use_id === 'string' && block.tool_use_id.trim()
                    ? block.tool_use_id
                    : undefined;
                blocks.push({
                    type: 'tool_result',
                    content: block?.content,
                    is_error: Boolean(block?.is_error),
                    tool_use_id: toolUseId
                });
                if (toolUseId) resolvedToolUseIds.add(toolUseId);
                continue;
            }

            // Fallback for unknown block types
            const fallback = safeJson(block, 900);
            if (fallback.trim()) {
                blocks.push({
                    type: 'text',
                    text: `[${blockType}] ${fallback}`
                });
            }
        }

        // Handle todos
        const todosText = formatClaudeTodos(raw?.todos);
        if (todosText) {
            blocks.push({
                type: 'plan',
                text: 'Todo List',
                explanation: todosText
            });
        }

        // Handle toolUseResult for backward compatibility
        if (blocks.length === 0 && raw?.toolUseResult != null) {
            const toolResultText = typeof raw.toolUseResult === 'string'
                ? raw.toolUseResult
                : safeJson(raw.toolUseResult, 1200);
            if (toolResultText.trim()) {
                blocks.push({
                    type: 'tool_result',
                    content: toolResultText,
                    is_error: toolResultText.toLowerCase().includes('error')
                });
            }
        }

        // Build messages from blocks
        blocks.forEach((block, blockIndex) => {
            messages.push(buildStructuredMessage(
                role,
                createdAt,
                turnId,
                itemId,
                blockIndex,
                block
            ));
        });
    });

    // Add approval_needed blocks for pending tool uses near the tail
    const nearTailIndex = Math.max(0, rawMessages.length - 3);
    for (const [toolUseId, pending] of pendingToolUses) {
        if (resolvedToolUseIds.has(toolUseId)) continue;
        if (pending.messageIndex < nearTailIndex) continue;

        messages.push(buildStructuredMessage(
            'assistant',
            pending.createdAt,
            pending.turnId,
            `${pending.itemId}-approval`,
            0,
            {
                type: 'approval_needed',
                title: 'Tool approval may be required',
                description: 'Attach this synced session to approve tool requests from Discord.',
                toolName: pending.toolName,
                status: 'pending',
                requiresAttach: true,
                payload: {
                    toolUseId,
                    input: pending.input
                }
            }
        ));
    }

    return messages;
}

/**
 * Read Claude session messages from disk
 */
export async function readClaudeSessionMessages(
    sessionId: string,
    projectPath: string
): Promise<{ messages: any[]; messageCount: number }> {
    try {
        const details = await getSessionDetailsAsync(sessionId, projectPath);
        if (!details) return { messages: [], messageCount: 0 };

        const rawMessages = Array.isArray(details.messages) ? details.messages : [];
        if (rawMessages.length === 0) {
            return { messages: [], messageCount: details.messageCount || 0 };
        }

        try {
            const structuredMessages = extractClaudeStructuredMessages(rawMessages);
            if (structuredMessages.length > 0) {
                return {
                    messages: structuredMessages,
                    messageCount: details.messageCount || structuredMessages.length
                };
            }
        } catch (error) {
            console.error(`[ClaudeSync] Structured extraction failed for ${sessionId}:`, error);
        }

        return {
            messages: rawMessages,
            messageCount: details.messageCount || rawMessages.length
        };
    } catch (error) {
        console.error(`[ClaudeSync] Error reading session ${sessionId}:`, error);
        return { messages: [], messageCount: 0 };
    }
}
