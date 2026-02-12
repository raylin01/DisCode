/**
 * Tmux Plugin for CLI Integration
 *
 * Uses tmux to manage persistent CLI sessions.
 * Based on vibecraft's proven approach:
 * - Creates tmux session with Claude running inside
 * - Sends prompts via `tmux send-keys`
 * - Polls output via `tmux capture-pane`
 * - Detects permission prompts by parsing screen output
 * - Responds to prompts by sending keystroke numbers
 *
 * HYBRID MODE:
 * - Also listens for 'hook_event' from PluginManager
 * - If a hook event is received, it uses that for permission detection (100% accurate)
 * - If no hook event, it falls back to screen scraping (zero-config)
 */
import { BasePlugin, PluginSession, SessionConfig } from './base.js';
export declare class TmuxPlugin extends BasePlugin {
    readonly name = "TmuxPlugin";
    readonly type: "tmux";
    readonly isPersistent = true;
    private pollInterval?;
    private healthInterval?;
    private tmuxPath;
    private sessionDiscoveryInterval?;
    private discoveredSessions;
    private skillManager?;
    initialize(): Promise<void>;
    private cleanupOrphanedSessions;
    shutdown(): Promise<void>;
    listSessions(): Promise<string[]>;
    /**
     * Get the current working directory of a tmux session
     */
    getSessionCwd(sessionId: string): Promise<string | null>;
    watchSession(sessionId: string): Promise<PluginSession>;
    private startSessionDiscovery;
    /**
     * Get the appropriate parser for a session's CLI type
     */
    private getCliParser;
    /**
     * Create a new CLI session in tmux
     * Supports both Claude and Gemini CLIs
     */
    createSession(config: SessionConfig): Promise<PluginSession>;
    private startPolling;
    private handleHookEvent;
    private pollSession;
    private getNewContent;
    private checkHealth;
}
