
import { EventEmitter } from 'events';
import path from 'path';
import { 
    SessionWatcher, 
    SessionEntry, 
    listProjectsAsync, 
    listSessions, 
    getSessionDetailsAsync
} from '@raylin01/claude-client/sessions';
import { CodexClient, Thread } from '@raylin01/codex-client';
import {
    listGeminiSessions as listGeminiProjectSessions,
    resolveGeminiSession
} from '@raylin01/gemini-client/sessions';
import { WebSocketManager } from '../websocket.js';
import { 
    SyncedContentBlock,
    SyncedSessionMessage,
    SyncProjectsResponseMessage, 
    SyncProjectsProgressMessage,
    SyncProjectsCompleteMessage,
    SyncSessionsResponseMessage, 
    SyncSessionsCompleteMessage,
    SyncSessionDiscoveredMessage, 
    SyncSessionUpdatedMessage 
} from '../../../shared/types.js';

/**
 * Runner-side Sync Service
 * 
 * Watches local files and pushes updates to Discord bot.
 */
export class RunnerSyncService extends EventEmitter {
    private watcher: SessionWatcher;
    private wsManager: WebSocketManager;
    private codexPath: string | null;
    private codexClient: CodexClient | null = null;
    private ownedSessions = new Set<string>(); // Sessions created/controlled by Discord
    private syncProjectsTask: Promise<void> | null = null;
    private syncSessionsTasks = new Map<string, Promise<void>>();
    private codexPollTimer: NodeJS.Timeout | null = null;
    private codexPollInFlight = false;
    private codexPollInitialized = false;
    private readonly codexPollIntervalMs = parseInt(process.env.DISCODE_CODEX_SYNC_POLL_MS || '15000');
    private codexThreadUpdatedAt = new Map<string, number>();
    private syncStatus: {
        state: 'idle' | 'syncing' | 'error';
        lastSyncAt?: string;
        lastError?: string;
        projects: Map<string, {
            projectPath: string;
            state: 'idle' | 'syncing' | 'complete' | 'error';
            lastSyncAt?: string;
            lastError?: string;
            sessionCount?: number;
        }>;
    } = {
        state: 'idle',
        projects: new Map()
    };
    private maxSyncChunkBytes = parseInt(process.env.DISCODE_SYNC_MAX_BYTES || String(2 * 1024 * 1024));

    constructor(wsManager: WebSocketManager, options?: { codexPath?: string | null }) {
        super();
        this.wsManager = wsManager;
        this.watcher = new SessionWatcher();
        this.codexPath = options?.codexPath || null;

        // Listen for watcher events
        this.watcher.on('session_new', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId) || this.ownedSessions.has(this.toSyncSessionKey(entry.sessionId, 'claude'))) return;
            void this.pushSessionDiscovered(entry);
        });

        this.watcher.on('session_updated', (entry: SessionEntry) => {
            if (this.ownedSessions.has(entry.sessionId) || this.ownedSessions.has(this.toSyncSessionKey(entry.sessionId, 'claude'))) return;
            void this.pushSessionUpdated(entry);
        });

        this.startCodexPolling();
    }

    private normalizeProjectPath(projectPath: string): string {
        if (!projectPath || typeof projectPath !== 'string') return projectPath;
        return path.resolve(projectPath);
    }

    private toSyncSessionKey(sessionId: string, cliType: 'claude' | 'codex' | 'gemini' = 'claude'): string {
        return `${cliType}:${sessionId}`;
    }

    private normalizeThreadRecord(thread: Thread): {
        sessionId: string;
        projectPath: string;
        firstPrompt: string;
        created: string;
        messageCount: number;
        gitBranch?: string;
        messages: any[];
        cliType: 'codex';
    } | null {
        const cwd = thread.cwd || (typeof thread.path === 'string' ? thread.path : null);
        if (!cwd) return null;

        const createdAt = typeof thread.createdAt === 'number'
            ? new Date(thread.createdAt * 1000)
            : new Date();

        return {
            sessionId: thread.id,
            projectPath: this.normalizeProjectPath(cwd),
            firstPrompt: thread.preview || 'Codex thread',
            created: createdAt.toISOString(),
            messageCount: 0,
            gitBranch: typeof thread.gitInfo?.branch === 'string' ? thread.gitInfo.branch : undefined,
            messages: [],
            cliType: 'codex'
        };
    }

    private async ensureCodexClient(): Promise<CodexClient | null> {
        if (!this.codexPath) return null;
        if (this.codexClient) return this.codexClient;

        this.codexClient = new CodexClient({ codexPath: this.codexPath });
        try {
            await this.codexClient.start();
            return this.codexClient;
        } catch (error) {
            console.error('[SyncService] Failed to initialize Codex client for sync:', error);
            this.codexClient = null;
            return null;
        }
    }

    private async listCodexThreads(): Promise<Thread[]> {
        const client = await this.ensureCodexClient();
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
            console.error('[SyncService] Failed listing Codex threads:', error);
            return [];
        }

        return threads;
    }

    private async listCodexProjects(): Promise<Map<string, number>> {
        const projects = new Map<string, number>();
        const threads = await this.listCodexThreads();
        for (const thread of threads) {
            const normalized = this.normalizeThreadRecord(thread);
            if (!normalized) continue;
            const key = normalized.projectPath;
            projects.set(key, (projects.get(key) || 0) + 1);
        }
        return projects;
    }

    private async listCodexSessions(projectPath: string): Promise<any[]> {
        const normalizedPath = this.normalizeProjectPath(projectPath);
        const sessions: any[] = [];
        const threads = await this.listCodexThreads();
        for (const thread of threads) {
            const record = this.normalizeThreadRecord(thread);
            if (!record) continue;
            if (record.projectPath !== normalizedPath) continue;
            sessions.push(record);
        }
        return sessions;
    }

    private async listGeminiSessionsForProject(projectPath: string): Promise<any[]> {
        const normalizedPath = this.normalizeProjectPath(projectPath);
        try {
            const sessions = await listGeminiProjectSessions({
                projectRoot: normalizedPath
            });

            return sessions.map((session) => ({
                sessionId: session.id,
                projectPath: normalizedPath,
                cliType: 'gemini' as const,
                firstPrompt: session.displayName || session.firstUserMessage || 'Gemini session',
                created: this.toIsoTimestamp(session.startTime),
                messageCount: typeof session.messageCount === 'number' ? session.messageCount : 0,
                messages: []
            }));
        } catch (error) {
            console.warn(`[SyncService] Gemini sessions unavailable for ${normalizedPath}:`, error);
            return [];
        }
    }

    private async listGeminiProjects(projectPaths: Iterable<string>): Promise<Map<string, number>> {
        const projects = new Map<string, number>();

        for (const rawPath of projectPaths) {
            const normalizedPath = this.normalizeProjectPath(rawPath);
            const sessions = await this.listGeminiSessionsForProject(normalizedPath);
            if (sessions.length > 0) {
                projects.set(normalizedPath, sessions.length);
            }
        }

        return projects;
    }

    private toIsoTimestamp(value: unknown): string {
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

    private safeJson(value: unknown, maxChars = 1500): string {
        try {
            const raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
            return raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
        } catch {
            return String(value);
        }
    }

    private collectTextFromUserInputs(content: any[]): string[] {
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

    private extractClaudeTextBlock(block: any): string | null {
        if (!block) return null;
        if (typeof block?.text === 'string' && block.text.trim()) return block.text.trim();
        if (typeof block?.content === 'string' && block.content.trim()) return block.content.trim();
        return null;
    }

    private formatClaudeTodos(todos: any[]): string | null {
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

    private extractClaudeStructuredMessages(rawMessages: any[]): SyncedSessionMessage[] {
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

        for (const raw of rawMessages) {
            const content = Array.isArray(raw?.message?.content) ? raw.message.content : [];
            for (const block of content) {
                if (block?.type === 'tool_result' && typeof block?.tool_use_id === 'string' && block.tool_use_id.trim()) {
                    resolvedToolUseIds.add(block.tool_use_id);
                }
            }
        }

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
            const createdAt = this.toIsoTimestamp(raw?.timestamp ?? Date.now());
            const turnId = `claude-${raw?.sessionId || 'session'}`;
            const itemId = typeof raw?.uuid === 'string' && raw.uuid.trim() ? raw.uuid : `line-${index}`;
            const blocks: SyncedContentBlock[] = [];

            if (rawType === 'summary' && typeof raw?.summary === 'string' && raw.summary.trim()) {
                blocks.push({ type: 'text', text: raw.summary.trim() });
            }

            const content = Array.isArray(raw?.message?.content) ? raw.message.content : [];
            for (const block of content) {
                const blockType = typeof block?.type === 'string' ? block.type : 'unknown';
                if (blockType === 'text' || blockType === 'input_text' || blockType === 'output_text' || blockType === 'inputText') {
                    const text = this.extractClaudeTextBlock(block);
                    if (text) blocks.push({ type: 'text', text });
                    continue;
                }

                if (blockType === 'thinking' && typeof block?.thinking === 'string' && block.thinking.trim()) {
                    blocks.push({ type: 'thinking', thinking: block.thinking.trim() });
                    continue;
                }

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

                const fallback = this.safeJson(block, 900);
                if (fallback.trim()) {
                    blocks.push({
                        type: 'text',
                        text: `[${blockType}] ${fallback}`
                    });
                }
            }

            const todosText = this.formatClaudeTodos(raw?.todos);
            if (todosText) {
                blocks.push({
                    type: 'plan',
                    text: 'Todo List',
                    explanation: todosText
                });
            }

            if (blocks.length === 0 && raw?.toolUseResult != null) {
                const toolResultText = typeof raw.toolUseResult === 'string'
                    ? raw.toolUseResult
                    : this.safeJson(raw.toolUseResult, 1200);
                if (toolResultText.trim()) {
                    blocks.push({
                        type: 'tool_result',
                        content: toolResultText,
                        is_error: toolResultText.toLowerCase().includes('error')
                    });
                }
            }

            blocks.forEach((block, blockIndex) => {
                messages.push(this.buildStructuredMessage(
                    role,
                    createdAt,
                    turnId,
                    itemId,
                    blockIndex,
                    block
                ));
            });
        });

        const nearTailIndex = Math.max(0, rawMessages.length - 3);
        for (const [toolUseId, pending] of pendingToolUses) {
            if (resolvedToolUseIds.has(toolUseId)) continue;
            if (pending.messageIndex < nearTailIndex) continue;

            messages.push(this.buildStructuredMessage(
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

    private commandResultText(item: any): string {
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

    private fileChangeResultText(item: any): string {
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
            if (changes.length > 20) lines.push(`- …and ${changes.length - 20} more`);
        }
        return lines.join('\n').trim();
    }

    private mcpResultText(item: any): string {
        const lines: string[] = [];
        if (typeof item?.status === 'string') lines.push(`Status: ${item.status}`);
        if (typeof item?.durationMs === 'number') lines.push(`Duration: ${item.durationMs} ms`);
        if (item?.error) {
            lines.push('');
            lines.push(`Error: ${this.safeJson(item.error, 800)}`);
        } else if (item?.result != null) {
            lines.push('');
            lines.push(this.safeJson(item.result, 1200));
        }
        return lines.join('\n').trim() || 'No MCP result available.';
    }

    private extractGeminiTextSnippets(value: unknown, depth = 0): string[] {
        if (depth > 6 || value == null) return [];

        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed ? [trimmed] : [];
        }

        if (Array.isArray(value)) {
            return value.flatMap((entry) => this.extractGeminiTextSnippets(entry, depth + 1));
        }

        if (typeof value !== 'object') return [];

        const obj = value as Record<string, unknown>;
        const snippets: string[] = [];

        snippets.push(...this.extractGeminiTextSnippets(obj.text, depth + 1));
        snippets.push(...this.extractGeminiTextSnippets(obj.content, depth + 1));
        snippets.push(...this.extractGeminiTextSnippets(obj.description, depth + 1));
        snippets.push(...this.extractGeminiTextSnippets(obj.output, depth + 1));
        snippets.push(...this.extractGeminiTextSnippets(obj.message, depth + 1));

        if (typeof obj.functionResponse === 'object' && obj.functionResponse) {
            const fnResp = obj.functionResponse as Record<string, unknown>;
            snippets.push(...this.extractGeminiTextSnippets(fnResp.response, depth + 1));
            snippets.push(...this.extractGeminiTextSnippets(fnResp.output, depth + 1));
        }

        snippets.push(...this.extractGeminiTextSnippets(obj.response, depth + 1));

        return snippets;
    }

    private extractGeminiToolResultText(value: unknown): string | null {
        const snippets = this.extractGeminiTextSnippets(value)
            .map((snippet) => snippet.trim())
            .filter((snippet) => snippet.length > 0);

        if (snippets.length > 0) {
            const unique = Array.from(new Set(snippets));
            return unique.join('\n').trim();
        }

        if (value == null) return null;
        const fallback = this.safeJson(value, 1200).trim();
        if (!fallback || fallback === '{}' || fallback === '[]') return null;
        return fallback;
    }

    private extractGeminiStructuredMessages(rawMessages: any[], sessionIdHint?: string): SyncedSessionMessage[] {
        const messages: SyncedSessionMessage[] = [];
        const turnId = `gemini-${sessionIdHint || 'session'}`;

        rawMessages.forEach((raw, index) => {
            const type = typeof raw?.type === 'string' ? raw.type : '';
            const role: 'user' | 'assistant' = type === 'user' ? 'user' : 'assistant';
            const createdAt = this.toIsoTimestamp(raw?.timestamp ?? raw?.createdAt ?? Date.now());
            const itemId = typeof raw?.id === 'string' && raw.id.trim() ? raw.id : `msg-${index}`;
            const blocks: SyncedContentBlock[] = [];

            const textSnippets = this.extractGeminiTextSnippets(raw?.content);
            for (const text of textSnippets) {
                blocks.push({ type: 'text', text });
            }

            const thoughts = Array.isArray(raw?.thoughts) ? raw.thoughts : [];
            for (const thought of thoughts) {
                const subject = typeof thought?.subject === 'string' ? thought.subject.trim() : '';
                const description = typeof thought?.description === 'string' ? thought.description.trim() : '';
                const lines = [subject, description].filter((line) => line.length > 0);
                if (lines.length > 0) {
                    blocks.push({ type: 'thinking', thinking: lines.join('\n') });
                }
            }

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
                const resultText = this.extractGeminiToolResultText(
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

            if (blocks.length === 0) {
                const fallback = this.safeJson(raw, 900).trim();
                if (fallback) {
                    blocks.push({ type: 'text', text: `[${type || 'message'}] ${fallback}` });
                }
            }

            blocks.forEach((block, blockIndex) => {
                messages.push(this.buildStructuredMessage(
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

    private buildStructuredMessage(
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

    private extractCodexStructuredMessages(thread: Thread): SyncedSessionMessage[] {
        const messages: SyncedSessionMessage[] = [];
        const turns = Array.isArray(thread.turns) ? thread.turns : [];

        turns.forEach((turn: any, turnIndex: number) => {
            const turnId = typeof turn?.id === 'string' ? turn.id : `turn-${turnIndex}`;
            const turnCreatedAt = this.toIsoTimestamp(turn?.createdAt ?? thread.updatedAt ?? Date.now());

            const turnInput = Array.isArray(turn?.input) ? turn.input : [];
            turnInput.forEach((entry: any, index: number) => {
                const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
                if (!text) return;
                messages.push(this.buildStructuredMessage(
                    'user',
                    turnCreatedAt,
                    turnId,
                    `input-${index}`,
                    0,
                    { type: 'text', text }
                ));
            });

            const items = Array.isArray(turn?.items) ? turn.items : [];
            items.forEach((wrappedItem: any, itemIndex: number) => {
                const item = wrappedItem?.item || wrappedItem;
                const itemType = typeof item?.type === 'string' ? item.type : 'unknown';
                const itemId = typeof item?.id === 'string' ? item.id : `item-${itemIndex}`;
                const createdAt = this.toIsoTimestamp(item?.createdAt ?? turnCreatedAt);

                const blocks: SyncedContentBlock[] = [];
                let role: 'user' | 'assistant' = 'assistant';

                switch (itemType) {
                    case 'userMessage': {
                        role = 'user';
                        const content = Array.isArray(item?.content) ? item.content : [];
                        const texts = this.collectTextFromUserInputs(content);
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
                            content: this.commandResultText(item)
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
                            content: this.fileChangeResultText(item)
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
                            content: this.mcpResultText(item)
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
                        const summary = this.safeJson(item, 900);
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
                    messages.push(this.buildStructuredMessage(
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

    // Legacy text-only extraction for fallback compatibility.
    private extractLegacyTextSnippets(value: any): string[] {
        if (value == null) return [];

        if (typeof value === 'string') {
            const trimmed = value.trim();
            return trimmed ? [trimmed] : [];
        }

        if (Array.isArray(value)) {
            return value.flatMap((entry) => this.extractLegacyTextSnippets(entry));
        }

        if (typeof value !== 'object') return [];

        const snippets: string[] = [];
        if (typeof value.text === 'string') snippets.push(...this.extractLegacyTextSnippets(value.text));
        if (typeof value.delta === 'string') snippets.push(...this.extractLegacyTextSnippets(value.delta));
        if (typeof value.content === 'string' || Array.isArray(value.content)) snippets.push(...this.extractLegacyTextSnippets(value.content));
        if (Array.isArray(value.contentItems)) snippets.push(...this.extractLegacyTextSnippets(value.contentItems));
        if (Array.isArray(value.input)) snippets.push(...this.extractLegacyTextSnippets(value.input));
        if (typeof value.message === 'string') snippets.push(...this.extractLegacyTextSnippets(value.message));

        return snippets;
    }

    private inferLegacyCodexRole(payload: any, fallback: 'assistant' | 'user' = 'assistant'): 'assistant' | 'user' {
        if (payload?.role === 'user') return 'user';
        if (payload?.role === 'assistant') return 'assistant';

        const type = typeof payload?.type === 'string' ? payload.type.toLowerCase() : '';
        if (type.includes('user') || type.startsWith('input')) return 'user';
        if (type.includes('agent') || type.includes('assistant') || type.includes('output')) return 'assistant';

        return fallback;
    }

    private extractLegacyCodexMessages(thread: Thread): any[] {
        const messages: any[] = [];
        const turns = Array.isArray(thread.turns) ? thread.turns : [];

        for (const turn of turns) {
            const seenTurnMessages = new Set<string>();

            const turnInput = Array.isArray((turn as any).input) ? (turn as any).input : [];
            for (const input of turnInput) {
                const snippets = this.extractLegacyTextSnippets(input);
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
                const snippets = this.extractLegacyTextSnippets(payload);
                if (snippets.length === 0) continue;

                const role = this.inferLegacyCodexRole(payload);
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

    private async readClaudeSessionMessages(sessionId: string, projectPath: string): Promise<{ messages: any[]; messageCount: number }> {
        try {
            const details = await getSessionDetailsAsync(sessionId, projectPath);
            if (!details) return { messages: [], messageCount: 0 };

            const rawMessages = Array.isArray(details.messages) ? details.messages : [];
            if (rawMessages.length === 0) {
                return { messages: [], messageCount: details.messageCount || 0 };
            }

            try {
                const structuredMessages = this.extractClaudeStructuredMessages(rawMessages);
                if (structuredMessages.length > 0) {
                    return {
                        messages: structuredMessages,
                        messageCount: details.messageCount || structuredMessages.length
                    };
                }
            } catch (error) {
                console.error(`[SyncService] Structured Claude extraction failed for ${sessionId}:`, error);
            }

            return {
                messages: rawMessages,
                messageCount: details.messageCount || rawMessages.length
            };
        } catch (error) {
            console.error(`[SyncService] Error reading Claude session ${sessionId}:`, error);
            return { messages: [], messageCount: 0 };
        }
    }

    private async readGeminiSessionMessages(sessionId: string, projectPath: string): Promise<{ messages: any[]; messageCount: number }> {
        try {
            const resolved = await resolveGeminiSession(sessionId, {
                projectRoot: this.normalizeProjectPath(projectPath)
            });
            const rawMessages = Array.isArray(resolved.record?.messages) ? resolved.record.messages : [];
            if (rawMessages.length === 0) {
                return { messages: [], messageCount: 0 };
            }

            try {
                const structuredMessages = this.extractGeminiStructuredMessages(rawMessages, resolved.record.sessionId);
                if (structuredMessages.length > 0) {
                    return {
                        messages: structuredMessages,
                        messageCount: structuredMessages.length
                    };
                }
            } catch (error) {
                console.error(`[SyncService] Structured Gemini extraction failed for ${sessionId}:`, error);
            }

            return {
                messages: rawMessages,
                messageCount: rawMessages.length
            };
        } catch (error) {
            console.error(`[SyncService] Error reading Gemini session ${sessionId}:`, error);
            return { messages: [], messageCount: 0 };
        }
    }

    private async readCodexThreadMessages(sessionId: string): Promise<{ messages: any[]; messageCount: number }> {
        const client = await this.ensureCodexClient();
        if (!client) return { messages: [], messageCount: 0 };

        try {
            const result = await client.readThread({ threadId: sessionId, includeTurns: true });
            const messages = this.extractCodexStructuredMessages(result.thread);
            const messageCount = messages.length || (Array.isArray(result.thread.turns) ? result.thread.turns.length : 0);
            return { messages, messageCount };
        } catch (error) {
            console.error(`[SyncService] Error reading Codex thread ${sessionId}:`, error);
            try {
                const fallback = await client.readThread({ threadId: sessionId, includeTurns: true });
                const legacyMessages = this.extractLegacyCodexMessages(fallback.thread);
                const fallbackCount = legacyMessages.length || (Array.isArray(fallback.thread.turns) ? fallback.thread.turns.length : 0);
                return { messages: legacyMessages, messageCount: fallbackCount };
            } catch (legacyError) {
                console.error(`[SyncService] Legacy fallback failed for Codex thread ${sessionId}:`, legacyError);
                return { messages: [], messageCount: 0 };
            }
        }
    }

    private startCodexPolling(): void {
        if (!this.codexPath) return;
        if (this.codexPollIntervalMs <= 0) return;
        if (this.codexPollTimer) return;

        this.codexPollTimer = setInterval(() => {
            void this.pollCodexThreads();
        }, this.codexPollIntervalMs);

        void this.pollCodexThreads();
    }

    private async pollCodexThreads(): Promise<void> {
        if (!this.codexPath) return;
        if (this.codexPollInFlight) return;
        this.codexPollInFlight = true;

        try {
            const threads = await this.listCodexThreads();
            const currentIds = new Set<string>();

            if (!this.codexPollInitialized) {
                for (const thread of threads) {
                    const updatedAt = typeof thread.updatedAt === 'number'
                        ? thread.updatedAt
                        : (typeof thread.createdAt === 'number' ? thread.createdAt : 0);
                    this.codexThreadUpdatedAt.set(thread.id, updatedAt);
                }
                this.codexPollInitialized = true;
                return;
            }

            for (const thread of threads) {
                const record = this.normalizeThreadRecord(thread);
                if (!record) continue;

                currentIds.add(record.sessionId);
                const sessionKey = this.toSyncSessionKey(record.sessionId, 'codex');
                if (this.ownedSessions.has(sessionKey) || this.ownedSessions.has(record.sessionId)) {
                    continue;
                }

                const updatedAt = typeof thread.updatedAt === 'number'
                    ? thread.updatedAt
                    : (typeof thread.createdAt === 'number' ? thread.createdAt : 0);
                const previousUpdatedAt = this.codexThreadUpdatedAt.get(record.sessionId);

                if (previousUpdatedAt == null) {
                    this.codexThreadUpdatedAt.set(record.sessionId, updatedAt);

                    const { messages, messageCount } = await this.readCodexThreadMessages(record.sessionId);
                    const discovered: SyncSessionDiscoveredMessage = {
                        type: 'sync_session_discovered',
                        data: {
                            runnerId: this.wsManager.runnerId,
                            syncFormatVersion: 2,
                            session: {
                                sessionId: record.sessionId,
                                projectPath: record.projectPath,
                                cliType: 'codex',
                                firstPrompt: record.firstPrompt,
                                created: record.created,
                                messageCount,
                                gitBranch: record.gitBranch,
                                messages
                            }
                        }
                    };
                    this.wsManager.send(discovered);
                    continue;
                }

                if (updatedAt <= previousUpdatedAt) continue;
                this.codexThreadUpdatedAt.set(record.sessionId, updatedAt);

                const { messages, messageCount } = await this.readCodexThreadMessages(record.sessionId);
                const updated: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        syncFormatVersion: 2,
                        session: {
                            sessionId: record.sessionId,
                            projectPath: record.projectPath,
                            cliType: 'codex',
                            messageCount
                        },
                        newMessages: messages
                    }
                };
                this.wsManager.send(updated);
            }

            for (const sessionId of this.codexThreadUpdatedAt.keys()) {
                if (!currentIds.has(sessionId)) {
                    this.codexThreadUpdatedAt.delete(sessionId);
                }
            }
        } catch (error) {
            console.error('[SyncService] Codex polling failed:', error);
        } finally {
            this.codexPollInFlight = false;
        }
    }

    /**
     * Start watching projects
     */
    startWatching(projectPaths: string[]): void {
        console.log(`[SyncService] Starting watch for ${projectPaths.length} projects`);
        projectPaths.forEach(path => {
            this.watcher.watchProject(path);
        });
    }

    /**
     * Mark a session as owned (don't push sync updates)
     */
    markAsOwned(sessionId: string, cliType: 'claude' | 'codex' | 'gemini' = 'claude'): void {
        this.ownedSessions.add(this.toSyncSessionKey(sessionId, cliType));
        if (cliType === 'claude') {
            this.watcher.markAsOwned(sessionId);
        }
    }

    /**
     * Get a snapshot of current sync status for bot queries
     */
    getStatusSnapshot(): {
        state: 'idle' | 'syncing' | 'error';
        lastSyncAt?: string;
        lastError?: string;
        projects: Record<string, {
            projectPath: string;
            state: 'idle' | 'syncing' | 'complete' | 'error';
            lastSyncAt?: string;
            lastError?: string;
            sessionCount?: number;
        }>;
    } {
        const projects: Record<string, any> = {};
        for (const [path, status] of this.syncStatus.projects.entries()) {
            projects[path] = { ...status };
        }
        return {
            state: this.syncStatus.state,
            lastSyncAt: this.syncStatus.lastSyncAt,
            lastError: this.syncStatus.lastError,
            projects
        };
    }

    sendStatusResponse(requestId: string): void {
        this.wsManager.send({
            type: 'sync_status_response',
            data: {
                runnerId: this.wsManager.runnerId,
                requestId,
                status: this.getStatusSnapshot()
            }
        });
    }

    /**
     * Handle explicit sync projects request
     */
    async handleSyncProjects(requestId?: string): Promise<void> {
        console.log('[SyncService] Handling sync_projects request');
        if (this.syncProjectsTask) {
            console.log('[SyncService] sync_projects already running, ignoring duplicate request');
            return;
        }

        const task = this.runSyncProjects(requestId);
        this.syncProjectsTask = task;
        try {
            await task;
        } finally {
            this.syncProjectsTask = null;
        }
    }

    /**
     * Handle explicit sync sessions request
     */
    async handleSyncSessions(projectPath: string, requestId?: string): Promise<void> {
        console.log(`[SyncService] Handling sync_sessions for ${projectPath}`);

        if (this.syncSessionsTasks.has(projectPath)) {
            console.log(`[SyncService] sync_sessions already running for ${projectPath}, ignoring duplicate request`);
            return;
        }

        const task = this.runSyncSessions(projectPath, requestId);
        this.syncSessionsTasks.set(projectPath, task);
        try {
            await task;
        } finally {
            this.syncSessionsTasks.delete(projectPath);
        }
    }

    async handleSyncSessionMessages(
        sessionId: string,
        projectPath: string,
        requestId?: string,
        cliType: 'claude' | 'codex' | 'gemini' = 'claude'
    ): Promise<void> {
        try {
            if (cliType === 'codex') {
                const { messages, messageCount } = await this.readCodexThreadMessages(sessionId);

                const codexMessage: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        syncFormatVersion: 2,
                        session: {
                            sessionId,
                            projectPath: this.normalizeProjectPath(projectPath),
                            cliType: 'codex',
                            messageCount
                        },
                        newMessages: messages
                    }
                };
                this.wsManager.send(codexMessage);
                return;
            }

            if (cliType === 'gemini') {
                const snapshot = await this.readGeminiSessionMessages(sessionId, projectPath);
                const geminiMessage: SyncSessionUpdatedMessage = {
                    type: 'sync_session_updated',
                    data: {
                        runnerId: this.wsManager.runnerId,
                        syncFormatVersion: 2,
                        session: {
                            sessionId,
                            projectPath: this.normalizeProjectPath(projectPath),
                            cliType: 'gemini',
                            messageCount: snapshot.messageCount || 0
                        },
                        newMessages: snapshot.messages
                    }
                };
                this.wsManager.send(geminiMessage);
                return;
            }

            const snapshot = await this.readClaudeSessionMessages(sessionId, projectPath);
            const message: SyncSessionUpdatedMessage = {
                type: 'sync_session_updated',
                data: {
                    runnerId: this.wsManager.runnerId,
                    syncFormatVersion: 2,
                    session: {
                        sessionId,
                        projectPath: this.normalizeProjectPath(projectPath),
                        cliType: 'claude',
                        messageCount: snapshot.messageCount || 0
                    },
                    newMessages: snapshot.messages
                }
            };
            this.wsManager.send(message);
        } catch (error) {
            console.error(`[SyncService] Error syncing session messages for ${sessionId}:`, error);
        }
    }

    private async runSyncProjects(requestId?: string): Promise<void> {
        const startedAt = new Date();
        this.syncStatus.state = 'syncing';
        this.syncStatus.lastError = undefined;

        this.wsManager.send({
            type: 'sync_projects_progress',
            data: {
                runnerId: this.wsManager.runnerId,
                requestId,
                phase: 'listing',
                completed: 0,
                message: 'Listing projects',
                timestamp: new Date().toISOString()
            }
        } as SyncProjectsProgressMessage);

        try {
            const claudeProjects = await listProjectsAsync();
            const codexProjects = await this.listCodexProjects();
            const knownProjectPaths = new Set<string>();
            const mergedProjects = new Map<string, { path: string; lastModified: Date; sessionCount: number }>();

            for (const existingProjectPath of this.syncStatus.projects.keys()) {
                knownProjectPaths.add(existingProjectPath);
            }

            for (const project of claudeProjects) {
                const normalizedPath = this.normalizeProjectPath(project.path);
                knownProjectPaths.add(normalizedPath);
                mergedProjects.set(normalizedPath, {
                    path: normalizedPath,
                    lastModified: project.lastModified,
                    sessionCount: project.sessionCount
                });
            }

            for (const [projectPath, sessionCount] of codexProjects.entries()) {
                knownProjectPaths.add(projectPath);
                const existing = mergedProjects.get(projectPath);
                if (existing) {
                    existing.sessionCount += sessionCount;
                    continue;
                }
                mergedProjects.set(projectPath, {
                    path: projectPath,
                    lastModified: new Date(),
                    sessionCount
                });
            }

            const geminiProjects = await this.listGeminiProjects(knownProjectPaths);
            for (const [projectPath, sessionCount] of geminiProjects.entries()) {
                const existing = mergedProjects.get(projectPath);
                if (existing) {
                    existing.sessionCount += sessionCount;
                    continue;
                }
                mergedProjects.set(projectPath, {
                    path: projectPath,
                    lastModified: new Date(),
                    sessionCount
                });
            }

            const projects = Array.from(mergedProjects.values());

            const response: SyncProjectsResponseMessage = {
                type: 'sync_projects_response',
                data: {
                    runnerId: this.wsManager.runnerId,
                    requestId,
                    projects: projects.map(p => ({
                        path: p.path,
                        lastModified: p.lastModified.toISOString(),
                        sessionCount: p.sessionCount
                    }))
                }
            };

            this.wsManager.send(response);

            // Update project status cache
            for (const project of projects) {
                const status = this.syncStatus.projects.get(project.path) || {
                    projectPath: project.path,
                    state: 'idle' as const
                };
                status.sessionCount = project.sessionCount;
                status.state = 'idle';
                this.syncStatus.projects.set(project.path, status);
            }

            this.startWatching(projects.map(p => p.path));

            this.syncStatus.state = 'idle';
            this.syncStatus.lastSyncAt = new Date().toISOString();

            this.wsManager.send({
                type: 'sync_projects_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    requestId,
                    projects: response.data.projects,
                    status: 'success',
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString()
                }
            } as SyncProjectsCompleteMessage);
        } catch (error: any) {
            console.error('[SyncService] Error listing projects:', error);
            this.syncStatus.state = 'error';
            this.syncStatus.lastError = error?.message || String(error);

            this.wsManager.send({
                type: 'sync_projects_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    requestId,
                    projects: [],
                    status: 'error',
                    error: this.syncStatus.lastError,
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString()
                }
            } as SyncProjectsCompleteMessage);
        }
    }

    private async runSyncSessions(projectPath: string, requestId?: string): Promise<void> {
        const startedAt = new Date();
        const normalizedProjectPath = this.normalizeProjectPath(projectPath);

        const projectStatus = this.syncStatus.projects.get(normalizedProjectPath) || {
            projectPath: normalizedProjectPath,
            state: 'idle' as const
        };
        projectStatus.state = 'syncing';
        projectStatus.lastError = undefined;
        this.syncStatus.projects.set(normalizedProjectPath, projectStatus);

        try {
            let claudeSessions: any[] = [];
            try {
                claudeSessions = await listSessions(normalizedProjectPath);
            } catch (error) {
                console.warn(`[SyncService] Claude sessions unavailable for ${normalizedProjectPath}:`, error);
            }

            const codexSessions = await this.listCodexSessions(normalizedProjectPath);
            const geminiSessions = await this.listGeminiSessionsForProject(normalizedProjectPath);
            const sessions = [...claudeSessions, ...codexSessions, ...geminiSessions];
            console.log(`[SyncService] Found ${sessions.length} sessions for ${normalizedProjectPath}`);
            const codexClient = codexSessions.length > 0 ? await this.ensureCodexClient() : null;

            const mappedSessions = [] as any[];
            for (const session of sessions) {
                const cliType: 'claude' | 'codex' | 'gemini' = session.cliType === 'codex'
                    ? 'codex'
                    : session.cliType === 'gemini'
                    ? 'gemini'
                    : 'claude';
                if (cliType === 'codex') {
                    let codexMessages = Array.isArray(session.messages) ? session.messages : [];
                    let codexMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0;

                    // thread/list does not reliably include turns; hydrate with thread/read for initial sync.
                    if (codexMessages.length === 0 && codexClient) {
                        const snapshot = await this.readCodexThreadMessages(session.sessionId);
                        codexMessages = snapshot.messages;
                        codexMessageCount = snapshot.messageCount;
                    }

                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: this.normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: codexMessageCount,
                        gitBranch: session.gitBranch,
                        messages: codexMessages
                    });
                } else if (cliType === 'gemini') {
                    let geminiMessages = Array.isArray(session.messages) ? session.messages : [];
                    let geminiMessageCount = typeof session.messageCount === 'number' ? session.messageCount : 0;

                    if (geminiMessages.length === 0) {
                        const snapshot = await this.readGeminiSessionMessages(session.sessionId, session.projectPath);
                        geminiMessages = snapshot.messages;
                        geminiMessageCount = snapshot.messageCount;
                    }

                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: this.normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: geminiMessageCount,
                        gitBranch: session.gitBranch,
                        messages: geminiMessages
                    });
                } else {
                    const claudeSnapshot = await this.readClaudeSessionMessages(session.sessionId, session.projectPath);
                    mappedSessions.push({
                        sessionId: session.sessionId,
                        projectPath: this.normalizeProjectPath(session.projectPath),
                        cliType,
                        firstPrompt: session.firstPrompt,
                        created: session.created,
                        messageCount: claudeSnapshot.messageCount || session.messageCount,
                        gitBranch: session.gitBranch,
                        messages: claudeSnapshot.messages
                    });
                }

                await new Promise<void>(resolve => setImmediate(resolve));
            }

            await this.sendSyncSessionsInChunks(normalizedProjectPath, requestId, mappedSessions);

            this.watcher.watchProject(normalizedProjectPath);

            projectStatus.state = 'complete';
            projectStatus.lastSyncAt = new Date().toISOString();
            projectStatus.sessionCount = sessions.length;
            this.syncStatus.projects.set(normalizedProjectPath, projectStatus);

            this.wsManager.send({
                type: 'sync_sessions_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath: normalizedProjectPath,
                    requestId,
                    status: 'success',
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString(),
                    sessionCount: sessions.length
                }
            } as SyncSessionsCompleteMessage);
        } catch (error: any) {
            console.error(`[SyncService] Error listing sessions for ${normalizedProjectPath}:`, error);
            projectStatus.state = 'error';
            projectStatus.lastError = error?.message || String(error);
            this.syncStatus.projects.set(normalizedProjectPath, projectStatus);

            this.wsManager.send({
                type: 'sync_sessions_complete',
                data: {
                    runnerId: this.wsManager.runnerId,
                    projectPath: normalizedProjectPath,
                    requestId,
                    status: 'error',
                    error: projectStatus.lastError,
                    startedAt: startedAt.toISOString(),
                    completedAt: new Date().toISOString(),
                    sessionCount: 0
                }
            } as SyncSessionsCompleteMessage);
        }
    }

    private async sendSyncSessionsInChunks(
        projectPath: string,
        requestId: string | undefined,
        sessions: any[]
    ): Promise<void> {
        const basePayload = {
            runnerId: this.wsManager.runnerId,
            projectPath,
            requestId,
            syncFormatVersion: sessions.some((session) =>
                session?.cliType === 'codex' || session?.cliType === 'claude' || session?.cliType === 'gemini'
            ) ? 2 : undefined
        };

        const fullResponse: SyncSessionsResponseMessage = {
            type: 'sync_sessions_response',
            data: { ...basePayload, sessions }
        };
        const fullJson = JSON.stringify(fullResponse);
        console.log(`[SyncService] Generated response size: ${(fullJson.length / 1024).toFixed(2)} KB`);

        if (fullJson.length <= this.maxSyncChunkBytes) {
            const sent = this.wsManager.send(fullResponse);
            if (sent) {
                console.log(`[SyncService] Successfully sent sync response for ${projectPath}`);
            } else {
                console.error(`[SyncService] FAILED to send sync response (ws connection issue?)`);
            }
            return;
        }

        console.warn(`[SyncService] Large sync payload (${(fullJson.length / 1024).toFixed(2)} KB). Sending in chunks...`);

        let batch: any[] = [];
        for (const session of sessions) {
            const candidate = [...batch, session];
            const response: SyncSessionsResponseMessage = {
                type: 'sync_sessions_response',
                data: { ...basePayload, sessions: candidate }
            };
            const size = JSON.stringify(response).length;
            if (size > this.maxSyncChunkBytes && batch.length > 0) {
                const sendResponse: SyncSessionsResponseMessage = {
                    type: 'sync_sessions_response',
                    data: { ...basePayload, sessions: batch }
                };
                const sent = this.wsManager.send(sendResponse);
                if (!sent) {
                    console.error(`[SyncService] FAILED to send sync response chunk for ${projectPath}`);
                    return;
                }
                batch = [session];
                await new Promise<void>(resolve => setImmediate(resolve));
            } else {
                batch = candidate;
            }
        }

        if (batch.length > 0) {
            const finalResponse: SyncSessionsResponseMessage = {
                type: 'sync_sessions_response',
                data: { ...basePayload, sessions: batch }
            };
            const sent = this.wsManager.send(finalResponse);
            if (!sent) {
                console.error(`[SyncService] FAILED to send final sync response chunk for ${projectPath}`);
                return;
            }
        }

        console.log(`[SyncService] Successfully sent chunked sync response for ${projectPath}`);
    }

    /**
     * Push new session discovery to Bot
     */
    private async pushSessionDiscovered(entry: SessionEntry): Promise<void> {
        const snapshot = await this.readClaudeSessionMessages(entry.sessionId, entry.projectPath);
        console.log(`[SyncService] Pushing session discovery: ${entry.sessionId} | Messages in file: ${snapshot.messages.length}`);
        const message: SyncSessionDiscoveredMessage = {
            type: 'sync_session_discovered',
            data: {
                runnerId: this.wsManager.runnerId,
                syncFormatVersion: 2,
                session: {
                    sessionId: entry.sessionId,
                    projectPath: this.normalizeProjectPath(entry.projectPath),
                    cliType: 'claude',
                    firstPrompt: entry.firstPrompt,
                    created: entry.created,
                    messageCount: snapshot.messageCount || entry.messageCount,
                    gitBranch: entry.gitBranch,
                    messages: snapshot.messages
                }
            }
        };
        this.wsManager.send(message);
    }

    /**
     * Push session update (new messages) to Bot
     */
    private async pushSessionUpdated(entry: SessionEntry): Promise<void> {
        const snapshot = await this.readClaudeSessionMessages(entry.sessionId, entry.projectPath);

        const message: SyncSessionUpdatedMessage = {
            type: 'sync_session_updated',
            data: {
                runnerId: this.wsManager.runnerId,
                syncFormatVersion: 2,
                session: {
                    sessionId: entry.sessionId,
                    projectPath: this.normalizeProjectPath(entry.projectPath),
                    cliType: 'claude',
                    messageCount: snapshot.messageCount || entry.messageCount
                },
                newMessages: snapshot.messages
            }
        };

        this.wsManager.send(message);
    }

    /**
     * Shutdown
     */
    shutdown(): void {
        this.watcher.close();
        if (this.codexPollTimer) {
            clearInterval(this.codexPollTimer);
            this.codexPollTimer = null;
        }
        if (this.codexClient) {
            void this.codexClient.shutdown().catch((error) => {
                console.error('[SyncService] Error shutting down Codex sync client:', error);
            });
            this.codexClient = null;
        }
    }
}

// Singleton
let syncServiceInstance: RunnerSyncService | null = null;

export function getSyncService(
    wsManager?: WebSocketManager,
    options?: { codexPath?: string | null }
): RunnerSyncService | null {
    if (!syncServiceInstance && wsManager) {
        syncServiceInstance = new RunnerSyncService(wsManager, options);
    }
    return syncServiceInstance;
}
