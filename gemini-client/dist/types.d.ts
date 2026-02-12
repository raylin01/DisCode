/// <reference types="node" />
export type GeminiOutputFormat = 'text' | 'json' | 'stream-json';
export type GeminiApprovalMode = 'default' | 'auto_edit' | 'yolo';
export interface GeminiClientOptions {
    cwd?: string;
    geminiPath?: string;
    env?: NodeJS.ProcessEnv;
    args?: string[];
    model?: string;
    outputFormat?: GeminiOutputFormat;
    yolo?: boolean;
    approvalMode?: GeminiApprovalMode;
    sandbox?: boolean;
    includeDirectories?: string[];
    allowedTools?: string[];
    allowedMcpServerNames?: string[];
    extensions?: string[];
    homeDir?: string;
    geminiDir?: string;
}
export interface GeminiRunOptions {
    resume?: string;
    model?: string;
    outputFormat?: GeminiOutputFormat;
    yolo?: boolean;
    approvalMode?: GeminiApprovalMode;
    sandbox?: boolean;
    includeDirectories?: string[];
    allowedTools?: string[];
    allowedMcpServerNames?: string[];
    extensions?: string[];
    extraArgs?: string[];
}
export declare enum JsonStreamEventType {
    INIT = "init",
    MESSAGE = "message",
    TOOL_USE = "tool_use",
    TOOL_RESULT = "tool_result",
    ERROR = "error",
    RESULT = "result"
}
export interface BaseJsonStreamEvent {
    type: JsonStreamEventType;
    timestamp: string;
}
export interface InitEvent extends BaseJsonStreamEvent {
    type: JsonStreamEventType.INIT;
    session_id: string;
    model: string;
}
export interface MessageEvent extends BaseJsonStreamEvent {
    type: JsonStreamEventType.MESSAGE;
    role: 'user' | 'assistant';
    content: string;
    delta?: boolean;
}
export interface ToolUseEvent extends BaseJsonStreamEvent {
    type: JsonStreamEventType.TOOL_USE;
    tool_name: string;
    tool_id: string;
    parameters: Record<string, unknown>;
}
export interface ToolResultEvent extends BaseJsonStreamEvent {
    type: JsonStreamEventType.TOOL_RESULT;
    tool_id: string;
    status: 'success' | 'error';
    output?: string;
    error?: {
        type: string;
        message: string;
    };
}
export interface ErrorEvent extends BaseJsonStreamEvent {
    type: JsonStreamEventType.ERROR;
    severity: 'warning' | 'error';
    message: string;
}
export interface StreamStats {
    total_tokens: number;
    input_tokens: number;
    output_tokens: number;
    cached: number;
    input: number;
    duration_ms: number;
    tool_calls: number;
}
export interface ResultEvent extends BaseJsonStreamEvent {
    type: JsonStreamEventType.RESULT;
    status: 'success' | 'error';
    error?: {
        type: string;
        message: string;
    };
    stats?: StreamStats;
}
export type JsonStreamEvent = InitEvent | MessageEvent | ToolUseEvent | ToolResultEvent | ErrorEvent | ResultEvent;
export interface GeminiRunResult {
    sessionId?: string;
    assistantResponse: string;
    status: 'success' | 'error';
    stats?: StreamStats;
    error?: {
        type: string;
        message: string;
    };
    events: JsonStreamEvent[];
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
    stdout: string[];
}
export interface GeminiSessionMessage {
    id?: string;
    type: 'user' | 'gemini' | 'info' | 'error' | 'warning' | string;
    timestamp?: string;
    content: unknown;
    [key: string]: unknown;
}
export interface GeminiSessionRecord {
    sessionId: string;
    projectHash: string;
    startTime: string;
    lastUpdated: string;
    messages: GeminiSessionMessage[];
    summary?: string;
}
export interface GeminiSessionInfo {
    id: string;
    file: string;
    fileName: string;
    startTime: string;
    lastUpdated: string;
    messageCount: number;
    displayName: string;
    firstUserMessage: string;
    isCurrentSession: boolean;
    index: number;
    summary?: string;
}
export interface GeminiSessionLocatorOptions {
    projectRoot: string;
    currentSessionId?: string;
    homeDir?: string;
    geminiDir?: string;
}
export interface ResolvedGeminiSession {
    session: GeminiSessionInfo;
    record: GeminiSessionRecord;
    filePath: string;
}
