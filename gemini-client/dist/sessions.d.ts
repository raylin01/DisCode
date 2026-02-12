import type { GeminiSessionInfo, GeminiSessionLocatorOptions, ResolvedGeminiSession } from './types.js';
export declare function listGeminiSessions(options: GeminiSessionLocatorOptions): Promise<GeminiSessionInfo[]>;
export declare function resolveGeminiSession(identifier: string, options: GeminiSessionLocatorOptions): Promise<ResolvedGeminiSession>;
export declare function deleteGeminiSession(identifier: string, options: GeminiSessionLocatorOptions): Promise<GeminiSessionInfo>;
export declare function getGeminiChatsPath(options: GeminiSessionLocatorOptions): string;
