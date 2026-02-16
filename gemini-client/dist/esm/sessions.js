import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { readFile, readdir, unlink } from 'fs/promises';
import { homedir } from 'os';
import { join, resolve } from 'path';
const GEMINI_DIR_NAME = '.gemini';
const SESSION_FILE_PREFIX = 'session-';
const CHATS_DIR = 'chats';
function toGlobalGeminiDir(options) {
    if (options.geminiDir)
        return options.geminiDir;
    return join(options.homeDir || homedir(), GEMINI_DIR_NAME);
}
function toProjectHash(projectRoot) {
    return createHash('sha256').update(resolve(projectRoot)).digest('hex');
}
function toChatsPath(options) {
    const geminiDir = toGlobalGeminiDir(options);
    const projectHash = toProjectHash(options.projectRoot);
    return join(geminiDir, 'tmp', projectHash, CHATS_DIR);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function stringifyContent(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content)) {
        return content.map((item) => stringifyContent(item)).join(' ');
    }
    if (isRecord(content)) {
        if (typeof content.text === 'string')
            return content.text;
        if (isRecord(content.functionCall) && typeof content.functionCall.name === 'string') {
            return `[tool:${content.functionCall.name}]`;
        }
        if (isRecord(content.functionResponse) && typeof content.functionResponse.name === 'string') {
            return `[tool_result:${content.functionResponse.name}]`;
        }
        try {
            return JSON.stringify(content);
        }
        catch {
            return '';
        }
    }
    if (content === null || content === undefined)
        return '';
    return String(content);
}
function cleanMessage(message) {
    return message
        .replace(/\n+/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/[^\x20-\x7E]+/g, '')
        .trim();
}
function hasUserOrAssistantMessage(messages) {
    return messages.some((msg) => msg.type === 'user' || msg.type === 'gemini');
}
function extractFirstUserMessage(messages) {
    const filteredUserMessage = messages
        .filter((msg) => msg.type === 'user')
        .find((msg) => {
        const content = cleanMessage(stringifyContent(msg.content));
        return content.length > 0 && !content.startsWith('/') && !content.startsWith('?');
    });
    if (filteredUserMessage) {
        return cleanMessage(stringifyContent(filteredUserMessage.content));
    }
    const firstUser = messages.find((msg) => msg.type === 'user');
    if (!firstUser)
        return 'Empty conversation';
    const content = cleanMessage(stringifyContent(firstUser.content));
    return content.length > 0 ? content : 'Empty conversation';
}
function toDisplayName(summary, fallback) {
    const candidate = cleanMessage(summary || '');
    if (candidate.length > 0)
        return candidate;
    return fallback;
}
function parseSessionRecord(raw) {
    try {
        const parsed = JSON.parse(raw);
        if (!isRecord(parsed))
            return null;
        if (typeof parsed.sessionId !== 'string')
            return null;
        if (typeof parsed.projectHash !== 'string')
            return null;
        if (typeof parsed.startTime !== 'string')
            return null;
        if (typeof parsed.lastUpdated !== 'string')
            return null;
        if (!Array.isArray(parsed.messages))
            return null;
        const messages = parsed.messages.filter(isRecord).map((msg) => ({
            ...msg
        }));
        return {
            sessionId: parsed.sessionId,
            projectHash: parsed.projectHash,
            startTime: parsed.startTime,
            lastUpdated: parsed.lastUpdated,
            messages,
            summary: typeof parsed.summary === 'string' ? parsed.summary : undefined
        };
    }
    catch {
        return null;
    }
}
export async function listGeminiSessions(options) {
    const chatsPath = toChatsPath(options);
    if (!existsSync(chatsPath))
        return [];
    const files = (await readdir(chatsPath))
        .filter((name) => name.startsWith(SESSION_FILE_PREFIX) && name.endsWith('.json'))
        .sort();
    const parsed = await Promise.all(files.map(async (fileName) => {
        try {
            const filePath = join(chatsPath, fileName);
            const raw = await readFile(filePath, 'utf8');
            const record = parseSessionRecord(raw);
            if (!record)
                return null;
            if (!hasUserOrAssistantMessage(record.messages))
                return null;
            const firstUserMessage = extractFirstUserMessage(record.messages);
            const shortId = record.sessionId.slice(0, 8);
            const isCurrentSession = Boolean(options.currentSessionId &&
                (options.currentSessionId === record.sessionId || fileName.includes(shortId)));
            const session = {
                id: record.sessionId,
                file: fileName.replace(/\.json$/i, ''),
                fileName,
                startTime: record.startTime,
                lastUpdated: record.lastUpdated,
                messageCount: record.messages.length,
                displayName: toDisplayName(record.summary, firstUserMessage),
                firstUserMessage,
                isCurrentSession,
                index: 0,
                summary: record.summary
            };
            return session;
        }
        catch {
            return null;
        }
    }));
    const uniqueById = new Map();
    for (const session of parsed) {
        if (!session)
            continue;
        const existing = uniqueById.get(session.id);
        if (!existing || new Date(session.lastUpdated).getTime() > new Date(existing.lastUpdated).getTime()) {
            uniqueById.set(session.id, session);
        }
    }
    const sessions = Array.from(uniqueById.values()).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    sessions.forEach((session, index) => {
        session.index = index + 1;
    });
    return sessions;
}
export async function resolveGeminiSession(identifier, options) {
    const sessions = await listGeminiSessions(options);
    if (sessions.length === 0) {
        throw new Error('No previous sessions found for this project.');
    }
    const normalized = identifier.trim();
    const sorted = sessions.slice().sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
    let selected;
    if (normalized === 'latest') {
        selected = sorted[sorted.length - 1];
    }
    else {
        selected = sorted.find((s) => s.id === normalized);
        if (!selected) {
            const asIndex = Number.parseInt(normalized, 10);
            const isCleanIndex = String(asIndex) === normalized;
            if (isCleanIndex && asIndex > 0 && asIndex <= sorted.length) {
                selected = sorted[asIndex - 1];
            }
        }
    }
    if (!selected) {
        throw new Error(`Invalid session identifier "${identifier}". Use "latest", an index number, or a session UUID.`);
    }
    const chatsPath = toChatsPath(options);
    const filePath = join(chatsPath, selected.fileName);
    const raw = await readFile(filePath, 'utf8');
    const record = parseSessionRecord(raw);
    if (!record) {
        throw new Error(`Failed to parse session file: ${filePath}`);
    }
    return { session: selected, record, filePath };
}
export async function deleteGeminiSession(identifier, options) {
    const resolved = await resolveGeminiSession(identifier, options);
    await unlink(resolved.filePath);
    return resolved.session;
}
export function getGeminiChatsPath(options) {
    return toChatsPath(options);
}
