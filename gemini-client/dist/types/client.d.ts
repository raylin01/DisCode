import { EventEmitter } from 'events';
import { type ErrorEvent, type GeminiClientOptions, type GeminiRunOptions, type GeminiRunResult, type GeminiSessionInfo, type JsonStreamEvent, type MessageEvent, type ResultEvent, type ToolResultEvent, type ToolUseEvent } from './types.js';
export declare interface GeminiClient {
    on(event: 'ready', listener: (sessionId: string) => void): this;
    on(event: 'event', listener: (event: JsonStreamEvent) => void): this;
    on(event: 'message', listener: (event: MessageEvent) => void): this;
    on(event: 'message_delta', listener: (delta: string) => void): this;
    on(event: 'tool_use', listener: (event: ToolUseEvent) => void): this;
    on(event: 'tool_result', listener: (event: ToolResultEvent) => void): this;
    on(event: 'result', listener: (event: ResultEvent) => void): this;
    on(event: 'error_event', listener: (event: ErrorEvent) => void): this;
    on(event: 'stderr', listener: (line: string) => void): this;
    on(event: 'stdout', listener: (line: string) => void): this;
    on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}
export declare class GeminiClient extends EventEmitter {
    private readonly options;
    private _sessionId;
    private activeProcess;
    private runChain;
    constructor(options?: GeminiClientOptions);
    get sessionId(): string | null;
    setSessionId(sessionId: string | null): void;
    start(): Promise<void>;
    startSession(prompt: string, runOptions?: GeminiRunOptions): Promise<GeminiRunResult>;
    continueSession(prompt: string, runOptions?: GeminiRunOptions): Promise<GeminiRunResult>;
    sendMessage(prompt: string, runOptions?: GeminiRunOptions): Promise<GeminiRunResult>;
    listSessions(): Promise<GeminiSessionInfo[]>;
    resolveSession(identifier: string): Promise<import("./types.js").ResolvedGeminiSession>;
    deleteSession(identifier: string): Promise<GeminiSessionInfo>;
    interrupt(signal?: NodeJS.Signals): Promise<void>;
    shutdown(): Promise<void>;
    private enqueue;
    private buildArgs;
    private toSpawnEnv;
    private isJsonStreamEvent;
    private onEvent;
    private runPrompt;
}
