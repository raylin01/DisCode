/**
 * Codex-specific sync logic
 * Handles extraction and transformation of Codex thread messages
 */

import { CodexClient, Thread } from '@raylin01/codex-client';
import {
    SyncedContentBlock,
    SyncedSessionMessage,
    safeJson,
    toIsoTimestamp,
    buildStructuredMessage,
    normalizeProjectPath,
    collectTextFromUserInputs
} from './sync-utils.js';

/**
 * Normalized thread record for sync
 */
export interface NormalizedThreadRecord {
    sessionId: string;
    projectPath: string;
    firstPrompt: string;
    created: string;
    messageCount: number;
    gitBranch?: string;
    messages: any[];
    cliType: 'codex';
}

/**
 * Format command execution result text
 */
export function commandResultText(item: any): string {
    const lines: string[] = [];
    if (typeof item?.status === 'string') lines.push(`Status: ${item.status}`);
    if (typeof item?.exitCode === 'number') lines.push(`Exit code: ${item.exitCode}`);
    if (typeof item?.durationMs === 'number') lines.push(`Duration: ${item.durationMs} ms`);
    if (typeof item?.processId === 'string' && item.processId.trim()) lines.push(`Process: ${item.processId}`);
    if (typeof item?.aggregatedOutput === 'string' && item.aggregatedOutput.trim()) {
        lines.push('');
        lines.push(item.aggregatedOutput.trim());
    }
    return lines.join('\n').trim() || 'No command output available.';
}

/**
 * Format file change result text
 */
export function fileChangeResultText(item: any): string {
    const lines: string[] = [];
    const changes = Array.isArray(item?.changes) ? item.changes : [];
    if (typeof item?.status === 'string') lines.push(`Status: ${item.status}`);
    lines.push(`Files changed: ${changes.length}`);
    if (changes.length > 0) {
        const preview = changes.slice(0, 20).map((change: any) => {
            const changePath = change?.path || change?.filePath || change?.file || change?.name || 'unknown';
            const kind = change?.kind || change?.changeType || 'updated';
            return `- ${kind}: ${changePath}`;
        });
        lines.push(...preview);
        if (changes.length > 20) lines.push(`- ...and ${changes.length - 20} more`);
    }
    return lines.join('\n').trim();
}

/**
 * Format MCP result text
 */
export function mcpResultText(item: any): string {
    const lines: string[] = [];
    if (typeof item?.status === 'string') lines.push(`Status: ${item.status}`);
    if (typeof item?.durationMs === 'number') lines.push(`Duration: ${item.durationMs} ms`);
    if (item?.error) {
        lines.push('');
        lines.push(`Error: ${safeJson(item.error, 800)}`);
    } else if (item?.result != null) {
        lines.push('');
        lines.push(safeJson(item.result, 1200));
    }
    return lines.join('\n').trim() || 'No MCP result available.';
}

/**
 * Normalize a Codex thread to a standard session record
 */
export function normalizeThreadRecord(thread: Thread): NormalizedThreadRecord | null {
    const cwd = thread.cwd || (typeof thread.path === 'string' ? thread.path : null);
    if (!cwd) return null;

    const createdAt = typeof thread.createdAt === 'number'
        ? new Date(thread.createdAt * 1000)
        : new Date();

    return {
        sessionId: thread.id,
        projectPath: normalizeProjectPath(cwd),
        firstPrompt: thread.preview || 'Codex thread',
        created: createdAt.toISOString(),
        messageCount: 0,
        gitBranch: typeof thread.gitInfo?.branch === 'string' ? thread.gitInfo.branch : undefined,
        messages: [],
        cliType: 'codex'
    };
}

/**
 * Extract structured messages from a Codex thread
 */
export function extractCodexStructuredMessages(thread: Thread): SyncedSessionMessage[] {
    const messages: SyncedSessionMessage[] = [];
    const turns = Array.isArray(thread.turns) ? thread.turns : [];

    turns.forEach((turn: any, turnIndex: number) => {
        const turnId = typeof turn?.id === 'string' ? turn.id : `turn-${turnIndex}`;
        const turnCreatedAt = toIsoTimestamp(turn?.createdAt ?? thread.updatedAt ?? Date.now());

        // Process turn input (user messages)
        const turnInput = Array.isArray(turn?.input) ? turn.input : [];
        turnInput.forEach((entry: any, index: number) => {
            const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
            if (!text) return;
            messages.push(buildStructuredMessage(
                'user',
                turnCreatedAt,
                turnId,
                `input-${index}`,
                0,
                { type: 'text', text }
            ));
        });

        // Process turn items
        const items = Array.isArray(turn?.items) ? turn.items : [];
        items.forEach((wrappedItem: any, itemIndex: number) => {
            const item = wrappedItem?.item || wrappedItem;
            const itemType = typeof item?.type === 'string' ? item.type : 'unknown';
            const itemId = typeof item?.id === 'string' ? item.id : `item-${itemIndex}`;
            const createdAt = toIsoTimestamp(item?.createdAt ?? turnCreatedAt);

            const blocks: SyncedContentBlock[] = [];
            let role: 'user' | 'assistant' = 'assistant';

            switch (itemType) {
                case 'userMessage': {
                    role = 'user';
                    const content = Array.isArray(item?.content) ? item.content : [];
                    const texts = collectTextFromUserInputs(content);
                    for (const text of texts) blocks.push({ type: 'text', text });
                    break;
                }
                case 'agentMessage': {
                    role = 'assistant';
                    if (typeof item?.text === 'string' && item.text.trim()) {
                        blocks.push({ type: 'text', text: item.text.trim() });
                    }
                    break;
                }
                case 'reasoning': {
                    role = 'assistant';
                    const summary = Array.isArray(item?.summary) ? item.summary.filter((x: any) => typeof x === 'string') : [];
                    const content = Array.isArray(item?.content) ? item.content.filter((x: any) => typeof x === 'string') : [];
                    const thinkingText = [...summary, ...content].join('\n').trim();
                    if (thinkingText) blocks.push({ type: 'thinking', thinking: thinkingText });
                    break;
                }
                case 'plan': {
                    role = 'assistant';
                    if (typeof item?.text === 'string' && item.text.trim()) {
                        blocks.push({ type: 'plan', text: item.text.trim() });
                    }
                    break;
                }
                case 'commandExecution': {
                    role = 'assistant';
                    blocks.push({
                        type: 'tool_use',
                        name: 'CommandExecution',
                        toolUseId: itemId,
                        input: {
                            command: item?.command,
                            cwd: item?.cwd,
                            commandActions: item?.commandActions
                        }
                    });
                    blocks.push({
                        type: 'tool_result',
                        tool_use_id: itemId,
                        is_error: item?.status === 'failed' || item?.status === 'declined',
                        content: commandResultText(item)
                    });
                    if (item?.status === 'inProgress') {
                        blocks.push({
                            type: 'approval_needed',
                            title: 'Command approval may be required',
                            description: 'Attach this synced session to approve command execution from Discord.',
                            toolName: 'CommandExecution',
                            status: item?.status,
                            requiresAttach: true,
                            payload: {
                                command: item?.command,
                                cwd: item?.cwd
                            }
                        });
                    }
                    break;
                }
                case 'fileChange': {
                    role = 'assistant';
                    blocks.push({
                        type: 'tool_use',
                        name: 'FileChange',
                        toolUseId: itemId,
                        input: {
                            changes: item?.changes,
                            status: item?.status
                        }
                    });
                    blocks.push({
                        type: 'tool_result',
                        tool_use_id: itemId,
                        is_error: item?.status === 'failed' || item?.status === 'declined',
                        content: fileChangeResultText(item)
                    });
                    if (item?.status === 'inProgress') {
                        blocks.push({
                            type: 'approval_needed',
                            title: 'File change approval may be required',
                            description: 'Attach this synced session to approve file changes from Discord.',
                            toolName: 'FileChange',
                            status: item?.status,
                            requiresAttach: true,
                            payload: {
                                status: item?.status,
                                changes: item?.changes
                            }
                        });
                    }
                    break;
                }
                case 'mcpToolCall': {
                    role = 'assistant';
                    blocks.push({
                        type: 'tool_use',
                        name: `MCP ${item?.server || 'server'}/${item?.tool || 'tool'}`,
                        toolUseId: itemId,
                        input: item?.arguments
                    });
                    blocks.push({
                        type: 'tool_result',
                        tool_use_id: itemId,
                        is_error: item?.status === 'failed',
                        content: mcpResultText(item)
                    });
                    break;
                }
                case 'webSearch': {
                    role = 'assistant';
                    const query = typeof item?.query === 'string' ? item.query : 'unknown query';
                    blocks.push({ type: 'text', text: `Web search: ${query}` });
                    break;
                }
                case 'imageView': {
                    role = 'assistant';
                    const imagePath = typeof item?.path === 'string' ? item.path : 'unknown path';
                    blocks.push({ type: 'text', text: `Viewed image: ${imagePath}` });
                    break;
                }
                case 'contextCompaction': {
                    role = 'assistant';
                    blocks.push({ type: 'text', text: 'Context was compacted for this thread.' });
                    break;
                }
                default: {
                    const summary = safeJson(item, 900);
                    if (summary.trim()) {
                        blocks.push({
                            type: 'text',
                            text: `[${itemType}] ${summary}`
                        });
                    }
                    break;
                }
            }

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
    });

    return messages;
}

/**
 * Extract legacy text snippets for fallback compatibility
 */
export function extractLegacyTextSnippets(value: any): string[] {
    if (value == null) return [];

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed ? [trimmed] : [];
    }

    if (Array.isArray(value)) {
        return value.flatMap((entry) => extractLegacyTextSnippets(entry));
    }

    if (typeof value !== 'object') return [];

    const snippets: string[] = [];
    if (typeof value.text === 'string') snippets.push(...extractLegacyTextSnippets(value.text));
    if (typeof value.delta === 'string') snippets.push(...extractLegacyTextSnippets(value.delta));
    if (typeof value.content === 'string' || Array.isArray(value.content)) snippets.push(...extractLegacyTextSnippets(value.content));
    if (Array.isArray(value.contentItems)) snippets.push(...extractLegacyTextSnippets(value.contentItems));
    if (Array.isArray(value.input)) snippets.push(...extractLegacyTextSnippets(value.input));
    if (typeof value.message === 'string') snippets.push(...extractLegacyTextSnippets(value.message));

    return snippets;
}

/**
 * Infer role for legacy Codex messages
 */
export function inferLegacyCodexRole(payload: any, fallback: 'assistant' | 'user' = 'assistant'): 'assistant' | 'user' {
    if (payload?.role === 'user') return 'user';
    if (payload?.role === 'assistant') return 'assistant';

    const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
    if (type.includes('user') || type.startsWith('input')) return 'user';
    if (type.includes('agent') || type.includes('assistant') || type.includes('output')) return 'assistant';

    return fallback;
}

/**
 * Extract legacy Codex messages for fallback
 */
export function extractLegacyCodexMessages(thread: Thread): any[] {
    const messages: any[] = [];
    const turns = Array.isArray(thread.turns) ? thread.turns : [];

    for (const turn of turns) {
        const seenTurnMessages = new Set<string>();

        const turnInput = Array.isArray((turn as any).input) ? (turn as any).input : [];
        for (const input of turnInput) {
            const snippets = extractLegacyTextSnippets(input);
            for (const text of snippets) {
                const dedupKey = `user:${text}`;
                if (seenTurnMessages.has(dedupKey)) continue;
                seenTurnMessages.add(dedupKey);
                messages.push({
                    type: 'message',
                    role: 'user',
                    content: [{ type: 'text', text }],
                    created_at: Date.now()
                });
            }
        }

        const items = Array.isArray((turn as any).items) ? (turn as any).items : [];
        for (const item of items) {
            const payload = (item as any).item || item;
            const snippets = extractLegacyTextSnippets(payload);
            if (snippets.length === 0) continue;

            const role = inferLegacyCodexRole(payload);
            for (const text of snippets) {
                const dedupKey = `${role}:${text}`;
                if (seenTurnMessages.has(dedupKey)) continue;
                seenTurnMessages.add(dedupKey);

                messages.push({
                    type: 'message',
                    role,
                    content: [{ type: 'text', text }],
                    created_at: Date.now()
                });
            }
        }
    }

    return messages;
}

/**
 * Codex client wrapper for sync operations
 */
export class CodexSyncClient {
    private client: CodexClient | null = null;

    constructor(private codexPath: string | null) {}

    async ensureClient(): Promise<CodexClient | null> {
        if (!this.codexPath) return null;
        if (this.client) return this.client;

        this.client = new CodexClient({ codexPath: this.codexPath });
        try {
            await this.client.start();
            return this.client;
        } catch (error) {
            console.error('[CodexSync] Failed to initialize client:', error);
            this.client = null;
            return null;
        }
    }

    async listThreads(): Promise<Thread[]> {
        const client = await this.ensureClient();
        if (!client) return [];

        const threads: Thread[] = [];
        let cursor: string | null = null;

        try {
            do {
                const response = await client.listThreads({
                    cursor,
                    limit: 200,
                    sortKey: 'updated_at',
                    archived: false
                });
                if (Array.isArray(response.data)) {
                    threads.push(...response.data);
                }
                cursor = response.nextCursor || null;
            } while (cursor);
        } catch (error) {
            console.error('[CodexSync] Failed listing threads:', error);
            return [];
        }

        return threads;
    }

    async listProjects(): Promise<Map<string, number>> {
        const projects = new Map<string, number>();
        const threads = await this.listThreads();
        for (const thread of threads) {
            const normalized = normalizeThreadRecord(thread);
            if (!normalized) continue;
            const key = normalized.projectPath;
            projects.set(key, (projects.get(key) || 0) + 1);
        }
        return projects;
    }

    async listSessions(projectPath: string): Promise<NormalizedThreadRecord[]> {
        const normalizedPath = normalizeProjectPath(projectPath);
        const sessions: NormalizedThreadRecord[] = [];
        const threads = await this.listThreads();
        for (const thread of threads) {
            const record = normalizeThreadRecord(thread);
            if (!record) continue;
            if (record.projectPath !== normalizedPath) continue;
            sessions.push(record);
        }
        return sessions;
    }

    async readThreadMessages(sessionId: string): Promise<{ messages: SyncedSessionMessage[]; messageCount: number }> {
        const client = await this.ensureClient();
        if (!client) return { messages: [], messageCount: 0 };

        try {
            const result = await client.readThread({ threadId: sessionId, includeTurns: true });
            const messages = extractCodexStructuredMessages(result.thread);
            const messageCount = messages.length || (Array.isArray(result.thread.turns) ? result.thread.turns.length : 0);
            return { messages, messageCount };
        } catch (error) {
            console.error(`[CodexSync] Error reading thread ${sessionId}:`, error);
            try {
                const fallback = await client.readThread({ threadId: sessionId, includeTurns: true });
                const legacyMessages = extractLegacyCodexMessages(fallback.thread);
                const fallbackCount = legacyMessages.length || (Array.isArray(fallback.thread.turns) ? fallback.thread.turns.length : 0);
                return { messages: legacyMessages, messageCount: fallbackCount };
            } catch (legacyError) {
                console.error(`[CodexSync] Legacy fallback failed for ${sessionId}:`, legacyError);
                return { messages: [], messageCount: 0 };
            }
        }
    }

    async shutdown(): Promise<void> {
        if (this.client) {
            await this.client.shutdown().catch((error) => {
                console.error('[CodexSync] Error shutting down client:', error);
            });
            this.client = null;
        }
    }
}
