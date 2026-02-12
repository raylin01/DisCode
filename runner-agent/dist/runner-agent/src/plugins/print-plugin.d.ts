/**
 * Print Plugin for CLI Integration
 *
 * Uses Claude's -p (print) mode with --session-id/--resume for conversation persistence.
 * Each message spawns a new process but session state is maintained by Claude.
 *
 * This is a simpler fallback that works without tmux.
 * Approvals are handled via HTTP hooks (not interactive).
 */
import { BasePlugin, PluginSession, SessionConfig } from './base.js';
export declare class PrintPlugin extends BasePlugin {
    readonly name = "PrintPlugin";
    readonly type: "print";
    readonly isPersistent = false;
    private skillManager?;
    initialize(): Promise<void>;
    createSession(config: SessionConfig): Promise<PluginSession>;
    log(message: string): void;
}
