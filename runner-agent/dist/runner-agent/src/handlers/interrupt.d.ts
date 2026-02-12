/**
 * Interrupt Handler
 *
 * Handles interrupt requests from Discord to stop CLI execution.
 */
import type { PluginSession } from '../plugins/index.js';
export interface InterruptHandlerDeps {
    cliSessions: Map<string, PluginSession>;
}
export declare function handleInterrupt(data: {
    sessionId: string;
    runnerId: string;
}, deps: InterruptHandlerDeps): Promise<void>;
