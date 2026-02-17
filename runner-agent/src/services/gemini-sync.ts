/**
 * Gemini-specific sync logic
 * Handles extraction and transformation of Gemini session messages
 */

import {
    listGeminiSessions as listGeminiProjectSessions,
    resolveGeminiSession
} from '@raylin01/gemini-client/sessions';
import {
    SyncedContentBlock,
    SyncedSessionMessage,
    safeJson,
    toIsoTimestamp,
    buildStructuredMessage,
    normalizeProjectPath
} from './sync-utils.js';

/**
 * Extract text snippets from Gemini message content recursively
 */
export function extractGeminiTextSnippets(value: unknown, depth = 0): string[] {
    if (depth > 6 || value == null) return [];

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry) => extractGeminiTextSnippets(entry, depth + 1));
    }

    if (typeof value !== 'object') return [];

    const obj = value as Record<string, unknown>;
    const snippets: string[] = [];

    snippets.push(...extractGeminiTextSnippets(obj.text, depth + 1));
    snippets.push(...extractGeminiTextSnippets(obj.content, depth + 1));
    snippets.push(...extractGeminiTextSnippets(obj.description, depth + 1));
    snippets.push(...extractGeminiTextSnippets(obj.output, depth + 1));
    snippets.push(...extractGeminiTextSnippets(obj.message, depth + 1));

    if (typeof obj.functionResponse === 'object' && obj.functionResponse) {
        const fnResp = obj.functionResponse as Record<string, unknown>;
        snippets.push(...extractGeminiTextSnippets(fnResp.response, depth + 1));
        snippets.push(...extractGeminiTextSnippets(fnResp.output, depth + 1));
    }

    snippets.push(...extractGeminiTextSnippets(obj.response, depth + 1));

    return snippets;
}

/**
 * Extract tool result text from Gemini responses
 */
export function extractGeminiToolResultText(value: unknown): string | null {
    const snippets = extractGeminiTextSnippets(value)
        .map((snippet) => snippet.trim())
        .filter((snippet) => snippet.length > 0);

    if (snippets.length > 0) {
        const unique = Array.from(new Set(snippets));
        return unique.join('\n').trim();
    }

    if (value == null) return null;
    const fallback = safeJson(value, 1200).trim();
    if (!fallback || fallback === '{}' || fallback === '[]') return null;
    return fallback;
}

/**
 * Extract structured messages from Gemini raw session messages
 */
export function extractGeminiStructuredMessages(rawMessages: any[], sessionIdHint?: string): SyncedSessionMessage[] {
    const messages: SyncedSessionMessage[] = [];
    const turnId = `gemini-${sessionIdHint || 'session'}`;

    rawMessages.forEach((raw, index) => {
        const type = typeof raw?.type === 'string' ? raw.type : '';
        const role: 'user' | 'assistant' = type === 'user' ? 'user' : 'assistant';
        const createdAt = toIsoTimestamp(raw?.timestamp ?? raw?.createdAt ?? Date.now());
        const itemId = typeof raw?.id === 'string' && raw.id.trim() ? raw.id : `msg-${index}`;
        const blocks: SyncedContentBlock[] = [];

        // Extract text content
        const textSnippets = extractGeminiTextSnippets(raw?.content);
        for (const text of textSnippets) {
            blocks.push({ type: 'text', text });
        }

        // Extract thoughts
        const thoughts = Array.isArray(raw?.thoughts) ? raw.thoughts : [];
        for (const thought of thoughts) {
            const subject = typeof thought?.subject === 'string' ? thought.subject.trim() : '';
            const description = typeof thought?.description === 'string' ? thought.description.trim() : '';
            const lines = [subject, description].filter((line) => line.length > 0);
            if (lines.length > 0) {
                blocks.push({ type: 'thinking', thinking: lines.join('\n') });
            }
        }

        // Extract tool calls
        const toolCalls = Array.isArray(raw?.toolCalls) ? raw.toolCalls : [];
        for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex += 1) {
            const toolCall = toolCalls[toolIndex];
            const toolName = typeof toolCall?.name === 'string' && toolCall.name.trim()
                ? toolCall.name
                : (typeof toolCall?.tool === 'string' && toolCall.tool.trim() ? toolCall.tool : 'ToolCall');
            const toolUseId = typeof toolCall?.id === 'string' && toolCall.id.trim()
                ? toolCall.id
                : `${itemId}:tool-${toolIndex}`;
            const status = typeof toolCall?.status === 'string' ? toolCall.status : undefined;
            const statusLower = status?.toLowerCase() || '';
            const isPending = statusLower.includes('pending')
                || statusLower.includes('in_progress')
                || statusLower.includes('inprogress')
                || statusLower.includes('running');
            const needsApproval = statusLower.includes('approval') || statusLower.includes('confirm');
            const hasError = statusLower.includes('error') || statusLower.includes('fail');
            const input = toolCall?.args ?? toolCall?.arguments ?? toolCall?.input;

            blocks.push({
                type: 'tool_use',
                name: toolName,
                input,
                toolUseId
            });

            const errorResult = toolCall?.error ?? toolCall?.result?.error;
            const resultText = extractGeminiToolResultText(
                errorResult ?? toolCall?.result ?? toolCall?.output ?? toolCall?.response
            );

            if (resultText) {
                blocks.push({
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: hasError || Boolean(errorResult),
                    content: resultText
                });
            } else if (status && !isPending) {
                blocks.push({
                    type: 'tool_result',
                    tool_use_id: toolUseId,
                    is_error: hasError,
                    content: `Status: ${status}`
                });
            }

            if (isPending || needsApproval) {
                blocks.push({
                    type: 'approval_needed',
                    title: 'Tool approval may be required',
                    description: 'Attach this synced session to approve tool requests from Discord.',
                    toolName,
                    status,
                    requiresAttach: true,
                    payload: {
                        toolUseId,
                        input
                    }
                });
            }
        }

        // Fallback for unrecognized content
        if (blocks.length === 0) {
            const fallback = safeJson(raw, 900).trim();
            if (fallback) {
                blocks.push({ type: 'text', text: `[${type || 'message'}] ${fallback}` });
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

    return messages;
}

/**
 * List Gemini sessions for a specific project
 */
export async function listGeminiSessionsForProject(projectPath: string): Promise<any[]> {
    const normalizedPath = normalizeProjectPath(projectPath);
    try {
        const sessions = await listGeminiProjectSessions({
            projectRoot: normalizedPath
        });

        return sessions.map((session) => ({
            sessionId: session.id,
            projectPath: normalizedPath,
            cliType: 'gemini' as const,
            firstPrompt: session.displayName || session.firstUserMessage || 'Gemini session',
            created: toIsoTimestamp(session.startTime),
            messageCount: typeof session.messageCount === 'number' ? session.messageCount : 0,
            messages: []
        }));
    } catch (error) {
        console.warn(`[GeminiSync] Sessions unavailable for ${normalizedPath}:`, error);
        return [];
    }
}

/**
 * List Gemini projects with session counts
 */
export async function listGeminiProjects(projectPaths: Iterable<string>): Promise<Map<string, number>> {
    const projects = new Map<string, number>();

    for (const rawPath of projectPaths) {
        const normalizedPath = normalizeProjectPath(rawPath);
        const sessions = await listGeminiSessionsForProject(normalizedPath);
        if (sessions.length > 0) {
            projects.set(normalizedPath, sessions.length);
        }
    }

    return projects;
}

/**
 * Read Gemini session messages from disk
 */
export async function readGeminiSessionMessages(
    sessionId: string,
    projectPath: string
): Promise<{ messages: SyncedSessionMessage[]; messageCount: number }> {
    try {
        const resolved = await resolveGeminiSession(sessionId, {
            projectRoot: normalizeProjectPath(projectPath)
        });
        const rawMessages = Array.isArray(resolved.record?.messages) ? resolved.record.messages : [];
        if (rawMessages.length === 0) {
            return { messages: [], messageCount: 0 };
        }

        try {
            const structuredMessages = extractGeminiStructuredMessages(rawMessages, resolved.record.sessionId);
            if (structuredMessages.length > 0) {
                return {
                    messages: structuredMessages,
                    messageCount: structuredMessages.length
                };
            }
        } catch (error) {
            console.error(`[GeminiSync] Structured extraction failed for ${sessionId}:`, error);
        }

        // Raw messages don't conform to SyncedSessionMessage, return empty
        return {
            messages: [],
            messageCount: rawMessages.length
        };
    } catch (error) {
        console.error(`[GeminiSync] Error reading session ${sessionId}:`, error);
        return { messages: [], messageCount: 0 };
    }
}
