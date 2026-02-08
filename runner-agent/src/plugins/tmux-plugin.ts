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

import { execFile, exec, ExecFileOptions } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
    OutputEvent,
    ApprovalEvent,
    StatusEvent,
    MetadataEvent,
    HookEvent,
    ToolExecutionEvent,
    ToolResultEvent,
    ApprovalOption
} from './base.js';
import { getPluginManager } from './plugin-manager.js';
import { getParser, type CliParser } from './parsers/index.js';
import { SkillManager } from '../utils/skill-manager.js';
import { getConfig } from '../config.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

// ============================================================================
// Constants
// ============================================================================

// Polling interval for permission checks (ms)
const PERMISSION_POLL_INTERVAL = 1000;
// Health check interval (ms)
const HEALTH_CHECK_INTERVAL = 5000;

const EXEC_OPTIONS = {
    maxBuffer: 1024 * 1024,
    timeout: 30000
};

// ============================================================================
// TmuxSession
// ============================================================================

class TmuxSession extends EventEmitter implements PluginSession {
    readonly sessionId: string;
    readonly config: SessionConfig;
    readonly createdAt: Date;


    status: SessionStatus = 'idle';
    lastActivity: Date;

    // Readiness tracking
    isReady: boolean = false;
    private booting: boolean = true;

    /** Internal tmux session name */
    readonly tmuxPath: string;

    /** Internal tmux session name */
    readonly tmuxSession: string;
    /** Current tool being used */
    currentTool?: string;
    /** Pending permission prompt */
    pendingPermission?: {
        tool: string;
        context: string;
        options: ApprovalOption[];
        detectedAt: Date;
    };
    /** Whether bypass warning has been handled */
    bypassWarningHandled = false;
    /** Last captured output for diffing */
    lastOutput = '';
    /** Token tracking */
    lastTokenCount = 0;
    cumulativeTokens = 0;
    /** Current mode (bypass, etc.) */
    currentMode?: string;
    /** Current activity (Thinking, Working, etc.) */
    currentActivity?: string;

    /** Last hook event timestamp (to debounce scraping) */
    lastHookEvent = 0;

    /** Whether this session is owned by us (true) or just watched (false) */
    readonly isOwned: boolean;

    /** Whether a command is currently running (for watched terminals) */
    isCommandRunning: boolean = false;

    constructor(config: SessionConfig, tmuxSession: string, tmuxPath: string, isOwned = true) {
        super();
        this.sessionId = config.sessionId;
        this.config = config;
        this.tmuxSession = tmuxSession;
        this.tmuxPath = tmuxPath;
        this.isOwned = isOwned;
        this.createdAt = new Date();
        this.lastActivity = new Date();

        // If not owned (watched session), assume ready immediately
        if (!isOwned) {
            this.booting = false;
            this.isReady = true;
            this.status = 'idle';
        }
    }

    async sendMessage(message: string): Promise<void> {
        console.log(`[TmuxSession] Sending message to ${this.tmuxSession}: ${JSON.stringify(message)}`);
        await sendToTmuxSafe(this.tmuxSession, message, this.tmuxPath);
        this.lastActivity = new Date();
        this.status = 'working';
    }

    async sendApproval(optionNumber: string, _message?: string, _requestId?: string): Promise<void> {
        if (!/^\d+$/.test(optionNumber)) {
            throw new Error(`Invalid approval option: ${optionNumber}`);
        }
        // Send number and Enter to ensure it's submitted
        console.log(`[TmuxSession] Sending approval option ${optionNumber} to ${this.tmuxSession} using ${this.tmuxPath}`);
        try {
            // Send number first
            await execFileAsync(this.tmuxPath, ['send-keys', '-t', this.tmuxSession, optionNumber], EXEC_OPTIONS);
            // Short delay to ensure it registers? usually not needed but safety
            // Then send Enter (using C-m is often safer than "Enter" keyword)
            await execFileAsync(this.tmuxPath, ['send-keys', '-t', this.tmuxSession, 'C-m'], EXEC_OPTIONS);
            console.log(`[TmuxSession] Approval sent successfully`);
        } catch (e) {
            console.error(`[TmuxSession] Failed to send approval:`, e);
            throw e;
        }
        this.pendingPermission = undefined;
        this.status = 'working';
        this.lastActivity = new Date();
    }

    async close(): Promise<void> {
        try {
            await execFileAsync(this.tmuxPath, ['kill-session', '-t', this.tmuxSession], EXEC_OPTIONS);
        } catch (e) {
            // Session might already be dead
        }
        this.status = 'offline';
        this.removeAllListeners();
    }

    /**
     * Interrupt the current CLI execution by sending Ctrl+C
     */
    async interrupt(): Promise<void> {
        console.log(`[TmuxSession] Sending interrupt (Ctrl+C) to ${this.tmuxSession}`);
        try {
            // Send Ctrl+C (C-c in tmux notation)
            await execFileAsync(this.tmuxPath, ['send-keys', '-t', this.tmuxSession, 'C-c'], EXEC_OPTIONS);
            console.log(`[TmuxSession] Interrupt sent successfully`);
            this.status = 'idle';
            this.lastActivity = new Date();
        } catch (e) {
            console.error(`[TmuxSession] Failed to send interrupt:`, e);
            throw e;
        }
    }

    // Internal method to mark as ready
    setReady(): void {
        if (!this.isReady) {
            this.isReady = true;
            this.booting = false;
            this.emit('ready');
        }
    }

    isBooting(): boolean {
        return this.booting;
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

function shortId(): string {
    return randomUUID().slice(0, 8);
}

function validateTmuxSession(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid tmux session name: ${name}`);
    }
}

/**
 * Safely send text to tmux session
 * Handles special characters and prevents injection
 */
async function sendToTmuxSafe(tmuxSession: string, text: string, tmuxPath: string): Promise<void> {
    validateTmuxSession(tmuxSession);

    // Use send-keys with literal flag to prevent interpretation
    // Split into chunks if very long
    const MAX_CHUNK = 500;

    for (let i = 0; i < text.length; i += MAX_CHUNK) {
        const chunk = text.slice(i, i + MAX_CHUNK);
        await execFileAsync(tmuxPath, ['send-keys', '-t', tmuxSession, '-l', chunk], EXEC_OPTIONS);
    }

    // Send Enter key
    await execFileAsync(tmuxPath, ['send-keys', '-t', tmuxSession, 'Enter'], EXEC_OPTIONS);
}

/**
 * Capture tmux pane output
 */
async function capturePane(tmuxSession: string, lines = 100, tmuxPath: string): Promise<string> {
    validateTmuxSession(tmuxSession);
    const { stdout } = await execFileAsync(
        tmuxPath,
        ['capture-pane', '-t', tmuxSession, '-p', '-S', `-${lines}`],
        { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 }
    );
    return stdout as string;
}

/**
 * Detect permission prompt in tmux output
 * Based on vibecraft's detection logic
 * Also detects startup prompts like Settings Error that block session
 */
function detectPermissionPrompt(output: string): { tool: string; context: string; options: ApprovalOption[] } | null {
    const lines = output.split('\n');

    // Look for various prompt patterns
    let proceedLineIdx = -1;
    let promptType: 'permission' | 'settings' | 'selector' = 'permission';

    // Scan last 50 lines
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        // Standard permission prompts
        if (/(Do you want|Would you like) to (proceed|make this edit)/i.test(lines[i])) {
            proceedLineIdx = i;
            promptType = 'permission';
            break;
        }
        // Settings Error prompts
        if (/Settings Error/i.test(lines[i])) {
            proceedLineIdx = i;
            promptType = 'settings';
            break;
        }
    }

    // If no explicit prompt found, look for selector pattern (❯ followed by numbered options)
    if (proceedLineIdx === -1) {
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
            if (/^\s*❯\s*\d+\./.test(lines[i])) {
                // Found a selector, look back for context
                proceedLineIdx = Math.max(0, i - 10);
                promptType = 'selector';
                break;
            }
        }
    }

    if (proceedLineIdx === -1) return null;

    // Verify this is a real prompt by checking for footer or selector
    let hasFooter = false;
    let hasSelector = false;
    for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 15); i++) {
        if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
            hasFooter = true;
            break;
        }
        if (/^\s*❯/.test(lines[i])) {
            hasSelector = true;
        }
    }

    // For settings/selector prompts, we don't require footer verification
    if (!hasFooter && !hasSelector && promptType === 'permission') return null;

    // Parse numbered options
    const options: ApprovalOption[] = [];
    const searchStart = promptType === 'selector' ? Math.max(0, proceedLineIdx) : proceedLineIdx + 1;
    for (let i = searchStart; i < Math.min(lines.length, searchStart + 15); i++) {
        const line = lines[i];
        if (/Esc to cancel/i.test(line)) break;

        const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/);
        if (optionMatch) {
            options.push({
                number: optionMatch[1],
                label: optionMatch[2].trim()
            });
        }
    }

    // For selector prompts (like Settings Error), we may only have 1 option
    if (options.length < 1) return null;
    if (options.length < 2 && promptType === 'permission') return null;

    // Find tool name based on prompt type
    let tool = 'Unknown';

    if (promptType === 'settings') {
        tool = 'Settings';
    } else if (promptType === 'selector') {
        tool = 'Prompt';
    } else {
        // Standard permission prompt - look for tool indicators
        for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
            // Pattern for tool indicators: ● ◐ · ⏺
            const toolMatch = lines[i].match(/[●◐·⏺]\s*(\w+)\s*\(/);
            if (toolMatch) {
                tool = toolMatch[1];
                break;
            }
            // Pattern for "Edit file .env" style
            const editMatch = lines[i].match(/^Edit file\s+(.+)$/i);
            if (editMatch) {
                tool = 'Edit';
                break;
            }
            const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Update|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i);
            if (cmdMatch) {
                tool = cmdMatch[1];
                break;
            }
        }
    }

    // Build context
    const contextStart = Math.max(0, proceedLineIdx - 10);
    const contextEnd = Math.min(lines.length, proceedLineIdx + 1 + options.length + 5);
    const context = lines.slice(contextStart, contextEnd).join('\n').trim();

    return { tool, context, options };
}

/**
 * Detect bypass permissions warning
 */
function detectBypassWarning(output: string): boolean {
    return output.includes('WARNING') && output.includes('Bypass Permissions mode');
}

/**
 * Clean ANSI codes from output
 */
function cleanOutput(str: string): string {
    return str
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
        .replace(/warn: CPU lacks AVX support.*?\.zip\s*/gs, '')
        // Remove shell prompts that appear before/after Claude
        .replace(/^\(base\).*?\$.*$/gm, '') // Conda/bash prompts
        .replace(/^The default interactive shell is now zsh\.$/gm, '')
        .replace(/^To update your account to use zsh.*$/gm, '')
        .replace(/^For more details.*HT\d+\.$/gm, '')
        // Remove Claude Code UI noise - Aggressive cleanup
        .replace(/^[─-]{3,}.*?$/gm, '') // Horizontal rules of any length
        .replace(/^\s*[>❯]\s*$/gm, '') // Empty prompt lines
        .replace(/.*?\? for shortcuts.*?$/gm, '') // Shortcut tips (match anywhere in line)
        .replace(/.*?Tip:.*?$/gm, '') // Usage tips (match anywhere in line)
        .replace(/bypass permissions on \(shift\+tab to cycle\)/gi, '')
        .replace(/plan mode \(shift\+tab to cycle\)/gi, '')
        .replace(/Type \/help to see available commands/gi, '')
        .replace(/Claude Code/gi, '') // Welcome message part
        .replace(/Welcome to Claude/gi, '') // Welcome message part
        .replace(/Welcome back!/gi, '') // Welcome back message
        .replace(/.*\/ide for Visual Studio Code.*/gi, '') // VS Code promotion
        .replace(/.*\/model to try.*/gi, '') // Model promotion
        .replace(/.*Tips for getting started.*/gi, '') // Tips header
        .replace(/.*Run \/init to create a CLAUDE\.md.*/gi, '') // Init tip
        .replace(/.*Note: You have launched claude in your.*/gi, '') // Launch note
        .replace(/.*Recent activity.*/gi, '') // Recent activity header
        .replace(/.*No recent activity.*/gi, '') // No recent activity
        .replace(/.*API Usage Billing.*/gi, '') // Billing note
        .replace(/.*Sonnet.*·.*/gi, '') // Model indicator line
        .replace(/.*Opus.*·.*/gi, '') // Model indicator line
        // Remove box drawing characters (welcome screen)
        .replace(/[╭─╮│╯╰▀▄█▌▐▖▗▘▙▚▛▜▝▞▟]/g, '')
        // Remove logo/art characters
        .replace(/[▐▛▜▌▝▘]/g, '')
        .replace(/\*\s*\*\s*\*/g, '') // Stars from logo
        // Remove startup noise
        .replace(/ide visual studio code/gi, '')
        .replace(/starting up/gi, '')
        .replace(/connected to .*? server/gi, '')
        // Remove activity status lines (managed via metadata)
        .replace(/[*✱✻]\s*[A-Za-z]+(?:…|\.\.\.)\s*(?:\(esc to interrupt\))?/gi, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
        .trim();
}

/**
 * Parse token count from Claude Code output
 * Patterns: ↓ 879 tokens, ↓ 1,234 tokens, ↓ 12.5k tokens
 */
function parseTokensFromOutput(output: string): number | null {
    let maxTokens = 0;

    // Pattern 1: plain numbers (possibly with commas) - ↓ 879 tokens, ↓ 1,234 tokens
    const plainPattern = /↓\s*([0-9,]+)\s*tokens?/gi;
    const plainMatches = output.matchAll(plainPattern);
    for (const match of plainMatches) {
        const num = parseInt(match[1].replace(/,/g, ''), 10);
        if (num > maxTokens) maxTokens = num;
    }

    // Pattern 2: k suffix (thousands) - ↓ 12.5k tokens, ↓ 12k tokens
    const kPattern = /↓\s*([0-9.]+)k\s*tokens?/gi;
    const kMatches = output.matchAll(kPattern);
    for (const match of kMatches) {
        const num = Math.round(parseFloat(match[1]) * 1000);
        if (num > maxTokens) maxTokens = num;
    }

    return maxTokens > 0 ? maxTokens : null;
}

/**
 * Parse current activity indicator from Claude Code output
 * Claude shows: * Thinking..., * Wrangling..., * Honking..., * Vibing..., etc.
 */
function parseActivity(output: string): string | null {
    // Match: * ActivityName... (esc to interrupt)
    // Or: ✻ ActivityName... (esc to interrupt)
    // Support both unicode ellipsis (…) and triple dots (...)
    const activityPattern = /[*✱✻]\s*([A-Za-z]+)(?:…|\.\.\.)\s*(?:\(esc to interrupt\))?/gi;
    const matches = [...output.matchAll(activityPattern)];

    // Return the last activity found (most recent)
    if (matches.length > 0) {
        return matches[matches.length - 1][1];
    }
    return null;
}
/**
 * Parse current mode from Claude Code output
 * e.g., "⏵⏵ bypass permissions on (shift+tab to cycle)"
 */
function parseMode(output: string): string | null {
    // Bypass permissions mode
    if (output.includes('bypass permissions on')) {
        return 'bypass';
    }
    // Plan mode
    if (output.includes('plan mode')) {
        return 'plan';
    }
    return null;
}

/**
 * Detect if output ends with a shell prompt (terminal is idle/not running)
 * Returns true if a shell prompt is detected at the end of the output
 */
function detectShellPrompt(output: string): boolean {
    // Get last few non-empty lines
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return true; // Empty = probably idle

    const lastLine = lines[lines.length - 1].trim();

    // Common shell prompt patterns:
    // Bash: "user@host:~$ " or "(base) MacBook-Pro-183:~ ray$"
    // Zsh: "➜ ~" or "❯" or "%"
    // Generic: ends with $ or # or % or > with optional space

    // Pattern 1: Ends with common prompt characters
    if (/[$#%>❯➜]\s*$/.test(lastLine)) {
        return true;
    }

    // Pattern 2: Bash/conda style prompt (hostname:path user$)
    if (/^(\([^)]+\)\s+)?\S+:\S*\s+\w+\$$/.test(lastLine)) {
        return true;
    }

    // Pattern 3: Just a prompt symbol
    if (/^[❯➜>%$#]\s*$/.test(lastLine)) {
        return true;
    }

    return false;
}

// ============================================================================
// TmuxPlugin
// ============================================================================

export class TmuxPlugin extends BasePlugin {
    readonly name = 'TmuxPlugin';
    readonly type = 'tmux' as const;
    readonly isPersistent = true;

    private pollInterval?: NodeJS.Timeout;
    private healthInterval?: NodeJS.Timeout;

    private tmuxPath = 'tmux'; // Default to just 'tmux', will be updated in initialize

    // Polling for new sessions
    private sessionDiscoveryInterval?: NodeJS.Timeout;
    private discoveredSessions = new Set<string>();


    private skillManager?: SkillManager;

    async initialize(): Promise<void> {
        await super.initialize();
        this.skillManager = new SkillManager(process.cwd());

        // Check tmux is available
        try {
            await execAsync('which tmux');
            this.log('tmux found via which');
            this.tmuxPath = 'tmux'; // Rely on PATH
        } catch {
            // "which" might fail if PATH is minimal (e.g. in some shells)
            // Try common locations
            const commonPaths = ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux'];
            let found = false;
            for (const p of commonPaths) {
                try {
                    await execFileAsync(p, ['-V']);
                    this.log(`tmux found at ${p}`);
                    this.tmuxPath = p; // Store absolute path
                    found = true;
                    break;
                } catch { }
            }
            if (!found) {
                // Last ditch: try to run "tmux -V" directly without path
                try {
                    await execFileAsync('tmux', ['-V']);
                    this.log('tmux found via direct execution');
                    this.tmuxPath = 'tmux';
                } catch {
                    this.log('CRITICAL: tmux not found in PATH or common locations');
                    throw new Error('tmux is not installed. Please install tmux to use TmuxPlugin.');
                }
            }
        }

        // Cleanup orphaned sessions from previous runs
        await this.cleanupOrphanedSessions();

        // Start polling
        this.startPolling();

        // Start session discovery if enabled (default true)
        const pollingEnabled = process.env.DISCODE_TMUX_POLLING !== 'false';
        if (pollingEnabled) {
            this.log('Starting session discovery polling...');
            this.startSessionDiscovery();
        } else {
            this.log('Session discovery polling disabled via DISCODE_TMUX_POLLING=false');
        }

        // Listen for hook events via PluginManager
        const pluginManager = getPluginManager();
        pluginManager.on('hook_event', (event: HookEvent) => {
            this.handleHookEvent(event);
        });
    }

    private async cleanupOrphanedSessions(): Promise<void> {
        this.log('Checking for orphaned discode-* sessions...');
        try {
            const sessions = await this.listSessions();
            let count = 0;
            for (const session of sessions) {
                if (session.startsWith('discode-')) {
                    this.log(`Cleaning up orphaned session: ${session}`);
                    try {
                        await execFileAsync(this.tmuxPath, ['kill-session', '-t', session], EXEC_OPTIONS);
                        count++;
                    } catch (e) {
                        // Ignore
                    }
                }
            }
            if (count > 0) {
                this.log(`Cleaned up ${count} orphaned sessions.`);
            } else {
                this.log('No orphaned sessions found.');
            }
        } catch (e) {
            // Ignore (e.g. no sessions)
        }
    }

    async shutdown(): Promise<void> {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.healthInterval) clearInterval(this.healthInterval);
        if (this.sessionDiscoveryInterval) clearInterval(this.sessionDiscoveryInterval);
        await super.shutdown();
    }

    async listSessions(): Promise<string[]> {
        try {
            const { stdout } = await execFileAsync(this.tmuxPath, ['list-sessions', '-F', '#{session_name}']);
            return stdout.trim().split('\n').filter(s => s.length > 0);
        } catch (e) {
            // If no sessions, tmux returns error code 1
            return [];
        }
    }

    /**
     * Get the current working directory of a tmux session
     */
    async getSessionCwd(sessionId: string): Promise<string | null> {
        try {
            const { stdout } = await execFileAsync(
                this.tmuxPath,
                ['display-message', '-t', sessionId, '-p', '#{pane_current_path}'],
                EXEC_OPTIONS
            );
            const cwd = stdout.trim();
            return cwd || null;
        } catch (e) {
            this.debug(`Failed to get cwd for session ${sessionId}: ${e}`);
            return null;
        }
    }

    async watchSession(sessionId: string): Promise<PluginSession> {
        // Verify session exists
        const sessions = await this.listSessions();
        if (!sessions.includes(sessionId)) {
            throw new Error(`Session ${sessionId} not found`);
        }

        // Get the actual working directory of the session
        const cwd = await this.getSessionCwd(sessionId) || '/';
        this.log(`Session ${sessionId} cwd: ${cwd}`);

        // Install skills into the watched session's workspace
        if (this.skillManager) {
            const cliType = 'claude'; // Default for watched sessions
            await this.skillManager.installSkills(cwd, cliType);
            this.log(`Installed skills for watched session ${sessionId}`);
        }

        // Create a config for this watched session
        const config: SessionConfig = {
            cliPath: 'watched', // Placeholder
            cwd: cwd, // Actual cwd from tmux
            sessionId: sessionId, // Use the tmux session name as our ID
            cliType: 'claude', // Default to claude for now, or maybe generic
            options: {
                continueConversation: true
            }
        };

        const session = new TmuxSession(config, sessionId, this.tmuxPath, false); // isOwned = false

        // CAPTURE INITIAL OUTPUT AS BASELINE
        // This prevents the first poll from emitting all visible content
        try {
            const initialOutput = await capturePane(sessionId, 100, this.tmuxPath);
            const cleaned = initialOutput.replace(/\x1b\[[0-9;]*[mGKH]/g, '')
                .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
                .trim();
            session.lastOutput = cleaned;
            this.log(`Captured initial output baseline (${cleaned.length} chars)`);
        } catch (e) {
            this.log(`Warning: Could not capture initial output for ${sessionId}`);
        }

        this.sessions.set(sessionId, session);

        // Mark as immediately ready since it's an existing session
        session.setReady();
        session.status = 'idle'; // Assume idle for now

        this.log(`Started watching session: ${sessionId}`);

        return session;
    }

    private startSessionDiscovery(): void {
        this.sessionDiscoveryInterval = setInterval(async () => {
            try {
                const currentSessions = await this.listSessions();

                for (const session of currentSessions) {
                    // Ignore sessions we created/own (starts with discode-)
                    // Actually, we might want to discover those too if we restarted?
                    // For now, let's just emit everything we haven't seen yet

                    if (!this.discoveredSessions.has(session)) {
                        this.discoveredSessions.add(session);

                        // Skip assistant sessions - they are managed separately by AssistantManager
                        // Note: tmux session name is 'discode-' + first 8 chars of sessionId (which starts with 'assistant-')
                        // After removing dashes and taking 8 chars, 'assistant-...' becomes 'assistan' (truncated)
                        if (session.includes('assistan')) {
                            this.log(`Skipping assistant session: ${session}`);
                            continue;
                        }

                        // We want to discover discode- sessions if we restarted !
                        // Only skip if we are already managing it
                        if (this.sessions.has(session)) {
                            continue;
                        }

                        // Don't emit for our own internal sessions if we just created them
                        // But wait, the bot needs to know about them? 
                        // The createSession flow handles owned sessions.
                        // We only care about EXTERNAL sessions or sessions we don't know about.

                        if (!this.sessions.has(session)) {
                            // Get the cwd for the discovered session
                            const cwd = await this.getSessionCwd(session);
                            this.log(`Discovered new external session: ${session} (cwd: ${cwd || 'unknown'})`);
                            this.emit('session_discovered', {
                                sessionId: session,
                                exists: true,
                                cwd: cwd
                            });
                        }
                    }
                }
            } catch (e) {
                // Ignore errors (e.g. no sessions)
            }
        }, 5000); // Check every 5 seconds
    }

    /**
     * Get the appropriate parser for a session's CLI type
     */
    private getCliParser(session: TmuxSession): CliParser {
        return getParser(session.config.cliType);
    }

    /**
     * Create a new CLI session in tmux
     * Supports both Claude and Gemini CLIs
     */
    async createSession(config: SessionConfig): Promise<PluginSession> {
        // Use the first 8 chars of the actual session ID so discovery can match it
        const sessionIdShort = config.sessionId.replace(/-/g, '').slice(0, 8);
        const tmuxSession = `discode-${sessionIdShort}`;

        // Build CLI-specific command
        const args: string[] = [];
        let cliCmd: string;

        if (config.cliType === 'claude') {
            const options = config.options || {};

            if (options.continueConversation) {
                args.push('--continue');
            }
            if (options.resumeSessionId) {
                args.push('--resume', options.resumeSessionId);
            }
            if (options.forkSession) {
                args.push('--fork-session');
            }
            if (options.resumeSessionAt) {
                args.push('--resume-session-at', options.resumeSessionAt);
            }
            if (options.persistSession === false) {
                args.push('--no-session-persistence');
            }
            if (options.maxTurns) {
                args.push('--max-turns', String(options.maxTurns));
            }
            if (options.maxBudgetUsd) {
                args.push('--max-budget-usd', String(options.maxBudgetUsd));
            }
            if (options.model) {
                args.push('--model', options.model);
            }
            if (options.fallbackModel) {
                args.push('--fallback-model', options.fallbackModel);
            }
            if (options.agent) {
                args.push('--agent', options.agent);
            }
            if (options.betas && options.betas.length > 0) {
                args.push('--betas', options.betas.join(','));
            }
            if (options.jsonSchema) {
                const schemaValue = typeof options.jsonSchema === 'string'
                    ? options.jsonSchema
                    : JSON.stringify(options.jsonSchema);
                args.push('--json-schema', schemaValue);
            }
            if (options.allowedTools && options.allowedTools.length > 0) {
                args.push('--allowedTools', options.allowedTools.join(','));
            }
            if (options.disallowedTools && options.disallowedTools.length > 0) {
                args.push('--disallowedTools', options.disallowedTools.join(','));
            }
            if (options.tools !== undefined) {
                if (Array.isArray(options.tools)) {
                    args.push('--tools', options.tools.length === 0 ? '' : options.tools.join(','));
                } else {
                    args.push('--tools', 'default');
                }
            }
            if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
                args.push('--mcp-config', JSON.stringify({ mcpServers: options.mcpServers }));
            }
            if (options.settingSources && options.settingSources.length > 0) {
                args.push('--setting-sources', options.settingSources.join(','));
            }
            if (options.strictMcpConfig) {
                args.push('--strict-mcp-config');
            }
            if (options.permissionMode) {
                args.push('--permission-mode', options.permissionMode);
            }
            if (options.allowDangerouslySkipPermissions || options.skipPermissions) {
                args.push('--allow-dangerously-skip-permissions');
            }
            if (options.includePartialMessages !== false) {
                args.push('--include-partial-messages');
            }
            if (options.permissionPromptToolName) {
                args.push('--permission-prompt-tool', options.permissionPromptToolName);
            } else if (options.permissionPromptTool) {
                args.push('--permission-prompt-tool', 'stdio');
            }
            if (options.additionalDirectories && options.additionalDirectories.length > 0) {
                for (const dir of options.additionalDirectories) {
                    args.push('--add-dir', dir);
                }
            }
            if (options.plugins && options.plugins.length > 0) {
                for (const plugin of options.plugins) {
                    if (plugin.type !== 'local') {
                        throw new Error(`Unsupported plugin type: ${plugin.type}`);
                    }
                    args.push('--plugin-dir', plugin.path);
                }
            }

            const extraArgs = { ...(options.extraArgs || {}) } as Record<string, any>;
            if (options.sandbox) {
                let settingsObj: Record<string, any> = { sandbox: options.sandbox };
                if (extraArgs.settings) {
                    if (typeof extraArgs.settings === 'string') {
                        try {
                            settingsObj = { ...JSON.parse(extraArgs.settings), sandbox: options.sandbox };
                        } catch (err) {
                            throw new Error('Failed to parse extraArgs.settings JSON while applying sandbox.');
                        }
                    } else if (typeof extraArgs.settings === 'object') {
                        settingsObj = { ...extraArgs.settings, sandbox: options.sandbox };
                    } else {
                        throw new Error('extraArgs.settings must be a string or object when sandbox is set.');
                    }
                }
                extraArgs.settings = JSON.stringify(settingsObj);
            }
            for (const [key, value] of Object.entries(extraArgs)) {
                if (value === null) {
                    args.push(`--${key}`);
                } else {
                    const val = typeof value === 'string' ? value : JSON.stringify(value);
                    args.push(`--${key}`, val);
                }
            }

            cliCmd = args.length > 0
                ? `${config.cliPath} ${args.join(' ')}`
                : config.cliPath;
        } else if (config.cliType === 'gemini') {
            // Gemini-specific args
            if (config.options?.skipPermissions !== false) {
                args.push('--yolo');  // Auto-approve all actions
            }
            cliCmd = args.length > 0
                ? `${config.cliPath} ${args.join(' ')}`
                : config.cliPath;
        } else {
            // Generic CLI - no special args
            cliCmd = config.cliPath;
        }

        this.log(`Creating ${config.cliType} session: ${tmuxSession} with cmd: ${cliCmd}`);

        // Install skills
        if (this.skillManager) {
            const cliType = config.cliType === 'gemini' ? 'gemini' : 'claude';
            await this.skillManager.installSkills(config.cwd, cliType, config.options?.excludedSkills);
        }

        // Env vars to inject
        const envVars = {
            DISCODE_SESSION_ID: config.sessionId,
            DISCODE_HTTP_PORT: getConfig().httpPort.toString(),
            DISCODE_RUNNER_ID: process.env.DISCODE_RUNNER_NAME || 'local-runner',
            ...config.options?.env
        };

        const envString = Object.entries(envVars)
            .map(([k, v]) => `${k}='${v}'`)
            .join(' ');

        // Wrap command in shell to keep pane open on failure for debugging
        const safeCmd = `bash -c "export ${envString}; ${cliCmd.replace(/"/g, '\\"')} || (echo 'Command failed with exit code $?'; echo 'Keeping pane open for debugging...'; sleep 60)"`;

        // Create tmux session
        await execFileAsync(this.tmuxPath, [
            'new-session',
            '-d',
            '-s', tmuxSession,
            '-c', config.cwd,
            safeCmd
        ], EXEC_OPTIONS);

        const session = new TmuxSession(config, tmuxSession, this.tmuxPath);
        this.sessions.set(config.sessionId, session);

        this.emit('status', {
            sessionId: config.sessionId,
            status: 'idle'
        });

        // NOTE: We do not emit 'output' right away. The poll loop will detect when readiness happens.
        return session;
    }

    private startPolling(): void {
        // Permission polling (every 1s)
        this.pollInterval = setInterval(() => {
            if (this.sessions.size > 0) {
                // Log only if we have sessions to avoid spamming empty state
                // actually, log specifically about watched sessions
                const watched = Array.from(this.sessions.values()).filter(s => !s.isOwned);
                if (watched.length > 0) {
                    this.log(`[DEBUG] Polling ${this.sessions.size} sessions (${watched.length} watched)...`);
                }
            }

            for (const session of this.sessions.values()) {
                if (session.status !== 'offline') {
                    this.pollSession(session as TmuxSession);
                } else {
                    if (!session.isOwned) this.log(`[DEBUG] Watched session ${session.sessionId} is OFFLINE, skipping poll`);
                }
            }
        }, PERMISSION_POLL_INTERVAL);

        // Health check (every 5s)
        this.healthInterval = setInterval(() => {
            this.checkHealth();
        }, HEALTH_CHECK_INTERVAL);

        this.log('Polling started');
    }

    private handleHookEvent(event: HookEvent): void {
        // Find session
        const session = this.sessions.get(event.sessionId);
        if (!session || session.status === 'offline') return;

        // Use event type from hook
        if ((event.type === 'PreToolUse' || event.type === 'pre_tool_use') && event.tool) {
            this.log(`[Hook] PreToolUse event received for tool: ${event.tool}`);

            // Map hook options to our format if available, otherwise default
            const options: ApprovalOption[] = [
                { number: '1', label: 'Yes' },
                { number: '2', label: 'Yes, always' },
                { number: '3', label: 'No' }
            ];

            const tmuxSession = (session as TmuxSession);

            // Set pending permission directly from hook (bypassing scraping delay)
            tmuxSession.pendingPermission = {
                tool: event.tool,
                context: typeof event.toolInput === 'string' ? event.toolInput : JSON.stringify(event.toolInput),
                options: options,
                detectedAt: new Date()
            };
            tmuxSession.status = 'waiting';
            tmuxSession.currentTool = event.tool;
            tmuxSession.lastHookEvent = Date.now(); // flag to suppress scraping for a bit

            this.emit('approval', {
                sessionId: session.sessionId,
                tool: event.tool,
                context: typeof event.toolInput === 'string' ? event.toolInput : JSON.stringify(event.toolInput),
                options: options,
                detectedAt: new Date()
            });

            this.emit('status', {
                sessionId: session.sessionId,
                status: 'waiting',
                currentTool: event.tool
            });
        }

        // Handle UserPrompt (Stop hook) - detection of idle state
        if (event.type === 'UserPrompt' || event.type === 'user_prompt') {
            this.log(`[Hook] UserPrompt event received (Stop signal)`);
            const tmuxSession = (session as TmuxSession);

            tmuxSession.status = 'idle';
            tmuxSession.currentTool = undefined;
            tmuxSession.currentActivity = undefined; // Clear activity
            tmuxSession.lastHookEvent = Date.now();

            this.emit('status', {
                sessionId: session.sessionId,
                status: 'idle'
            });

            // Force immediate poll to capture the prompt text
            this.pollSession(tmuxSession).catch(e => console.error(e));
        }
    }

    private async pollSession(session: TmuxSession): Promise<void> {
        try {
            const output = await capturePane(session.tmuxSession, 100, session.tmuxPath);

            // Get the appropriate parser for this CLI type
            const parser = this.getCliParser(session);

            // Use parser-specific cleaning for owned sessions
            let cleaned: string;
            if (session.isOwned) {
                // Owned session: use CLI-specific cleaning
                cleaned = parser.cleanOutput(output);
            } else {
                // Watched session: detect CLI type from output
                const isClaudeSession = output.includes('Claude Code') ||
                    output.includes('⏺') ||
                    output.includes('Sonnet') ||
                    output.includes('Opus');

                if (isClaudeSession) {
                    cleaned = getParser('claude').cleanOutput(output);
                } else {
                    // Generic terminal: minimal cleaning (just ANSI)
                    cleaned = getParser('generic').cleanOutput(output);
                }

                // DEBUG LOGGING
                if (!session.isOwned) {
                    const diff = this.getNewContent(session.lastOutput, cleaned, false);
                    if (diff) {
                        this.log(`[DEBUG] Watched session ${session.sessionId}: Found new content (${diff.length} chars)`);
                    } else if (cleaned !== session.lastOutput) {
                        this.log(`[DEBUG] Watched session ${session.sessionId}: Content changed but getNewContent returned null`);
                        this.log(`[DEBUG] Old len: ${session.lastOutput.length}, New len: ${cleaned.length}`);
                    }
                }
            }

            // Startup Phase Handling
            if (session.isBooting()) {
                // Use parser to detect readiness
                if (parser.detectReady(output)) {
                    this.log(`Session ${session.sessionId} is ready (${parser.name} detected prompt)`);
                    session.setReady();

                    // Emit CLI-specific ready message
                    const cliName = session.config.cliType === 'claude' ? 'Claude Code' :
                        session.config.cliType === 'gemini' ? 'Gemini CLI' :
                            'CLI';

                    this.emit('output', {
                        sessionId: session.sessionId,
                        content: `${cliName} Ready`,
                        isComplete: true,
                        outputType: 'info',
                        timestamp: new Date()
                    });

                    // Capture current state as the baseline so we don't emit the welcome noise
                    session.lastOutput = cleaned;
                } else {
                    // Still booting, suppress all output
                    // Just update lastOutput silently to keep track
                    session.lastOutput = cleaned;
                    return;
                }
            }

            // Normal Operation Phase

            // If we recently received a hook event (last 2 seconds), trust that over scraping
            // This prevents double-handling or race conditions
            if (Date.now() - session.lastHookEvent < 2000) {
                // Still update output/metadata, but skip permission detection
                // We rely on the hook for permissions during this window
            } else {
                // Check for bypass warning (first run of --dangerously-skip-permissions)
                if (detectBypassWarning(output) && !session.bypassWarningHandled) {
                    this.log(`Bypass warning detected for ${session.sessionId}, auto-accepting...`);
                    session.bypassWarningHandled = true;
                    // Use C-m for reliability
                    await execFileAsync(this.tmuxPath, ['send-keys', '-t', session.tmuxSession, '2', 'C-m'], EXEC_OPTIONS);
                    return; // Don't verify prompt if we just clicked it
                }

                // Check for permission prompts via scraping
                const prompt = detectPermissionPrompt(cleaned);

                if (prompt && !session.pendingPermission) {
                    // NEW PROMPT detected via scraping
                    session.pendingPermission = {
                        tool: prompt.tool,
                        context: prompt.context,
                        options: prompt.options,
                        detectedAt: new Date()
                    };
                    session.status = 'waiting';
                    session.currentTool = prompt.tool;

                    this.log(`Permission prompt detected (scraping): ${prompt.tool}`);

                    this.emit('approval', {
                        sessionId: session.sessionId,
                        tool: prompt.tool,
                        context: prompt.context,
                        options: prompt.options,
                        detectedAt: new Date()
                    });

                    this.emit('status', {
                        sessionId: session.sessionId,
                        status: 'waiting',
                        currentTool: prompt.tool
                    });
                }
                // Check for IDLE state (prompt detected)
                // If we are 'working' and see a prompt at the end, we are now 'idle'
                else if (session.status === 'working') {
                    // Check for prompt at the end of the cleaned output
                    // Claude Code prompt usually ends with ">" or "❯"
                    // We check the last line
                    const lastLine = cleaned.split('\n').pop() || '';
                    if (/^[>❯]\s*$/.test(lastLine) || cleaned.trim().endsWith('>') || cleaned.trim().endsWith('❯')) {
                        this.log(`Prompt detected for ${session.sessionId}, marking as idle`);
                        session.status = 'idle';
                        session.currentTool = undefined;

                        this.emit('status', {
                            sessionId: session.sessionId,
                            status: 'idle'
                        });

                        // Also emit an 'isComplete' output event to be sure
                        this.emit('output', {
                            sessionId: session.sessionId,
                            content: '', // Empty content update
                            isComplete: true,
                            outputType: 'stdout',
                            timestamp: new Date()
                        });
                    }
                }
            }

            // Check if permission was resolved externally (e.g. user clicked header button in Claude TUI)
            // or if we need to clear the pending state
            if (!detectPermissionPrompt(output) && session.pendingPermission && Date.now() - session.pendingPermission.detectedAt.getTime() > 1000) {
                // Prompt disappeared from screen?
                // But be careful, sometimes it just scrolls up.
                // For now, we trust our infinite wait unless manually cleared.
            }

            // Emit output if changed significantly
            if (cleaned !== session.lastOutput && cleaned.length > 0) {
                // Use diff-based approach for all sessions
                // For CLI-owned sessions, use aggressive diffing
                const isCliSession = session.isOwned || session.config.cliType === 'claude' || session.config.cliType === 'gemini';
                const contentToEmit = this.getNewContent(session.lastOutput, cleaned, isCliSession);

                if (contentToEmit) {
                    this.emit('output', {
                        sessionId: session.sessionId,
                        content: contentToEmit,
                        isComplete: false,
                        outputType: 'stdout',
                        timestamp: new Date()
                    });
                }
                session.lastOutput = cleaned;
            }

            // Parse and emit metadata (tokens, activity, mode)
            const tokens = parseTokensFromOutput(output);
            const activity = parseActivity(output);
            const mode = parseMode(output);

            let metadataChanged = false;

            // Update tokens if changed
            if (tokens !== null && tokens > session.lastTokenCount) {
                const delta = tokens - session.lastTokenCount;
                session.cumulativeTokens += delta;
                session.lastTokenCount = tokens;
                metadataChanged = true;
            }

            // Update activity if changed (only track when activity starts, not when it ends)
            if (activity !== null && activity !== session.currentActivity) {
                session.currentActivity = activity;
                metadataChanged = true;
            } else if (activity === null && session.currentActivity !== undefined) {
                // Activity cleared - just mark as idle, don't spam
                session.currentActivity = undefined;
                // Don't mark as changed to avoid spam
            }

            // Update mode if changed (only when new mode detected)
            if (mode !== null && mode !== session.currentMode) {
                session.currentMode = mode;
                metadataChanged = true;
            }

            // For watched terminals (generic, not CLI sessions), detect if a command is running
            // by checking if the output ends with a shell prompt
            const isGenericWatchedSession = !session.isOwned && session.config.cliType !== 'claude' && session.config.cliType !== 'gemini';
            if (isGenericWatchedSession) {
                const hasPrompt = detectShellPrompt(cleaned);
                const wasRunning = session.isCommandRunning;
                session.isCommandRunning = !hasPrompt;

                // Emit status change when running state changes
                if (wasRunning !== session.isCommandRunning) {
                    const newStatus = session.isCommandRunning ? 'working' : 'idle';
                    this.log(`Terminal ${session.sessionId} is now ${newStatus}`);
                    session.status = newStatus;

                    this.emit('status', {
                        sessionId: session.sessionId,
                        status: newStatus,
                        isCommandRunning: session.isCommandRunning
                    });
                }
            }

            // Emit metadata event only if something meaningful changed
            if (metadataChanged) {
                this.log(`Metadata: tokens=${session.lastTokenCount} activity=${session.currentActivity} mode=${session.currentMode}`);
                this.emit('metadata', {
                    sessionId: session.sessionId,
                    tokens: session.lastTokenCount || undefined,
                    cumulativeTokens: session.cumulativeTokens || undefined,
                    mode: session.currentMode,
                    activity: session.currentActivity,
                    isCommandRunning: session.isCommandRunning,
                    timestamp: new Date()
                });
            }

        } catch (e) {
            // Session might be dead
            this.debug(`Poll failed for ${session.sessionId}: ${e}`);
        }
    }

    private getNewContent(oldOutput: string, newOutput: string, isClaudeCode: boolean = true): string | null {
        if (!oldOutput) return newOutput;
        if (oldOutput === newOutput) return null;

        const oldLines = oldOutput.split('\n');
        const newLines = newOutput.split('\n');

        // Look for the largest overlap where the SUFFIX of old matching the PREFIX of new
        // This handles appending, scrolling, etc.
        const maxPossOverlap = Math.min(oldLines.length, newLines.length);
        let bestOverlap = 0;

        for (let len = maxPossOverlap; len > 0; len--) {
            // Check if suffix of old (length len) matches prefix of new (length len)
            let match = true;
            for (let i = 0; i < len; i++) {
                // Determine start indices
                // Old suffix starts at: oldLines.length - len
                // New prefix starts at: 0
                if (oldLines[oldLines.length - len + i] !== newLines[i]) {
                    match = false;
                    break;
                }
            }

            if (match) {
                bestOverlap = len;
                break;
            }
        }

        // If no overlap, assume completely new content (clear screen or fast scroll)
        if (bestOverlap === 0) {
            return newOutput;
        }

        const addedLines = newLines.slice(bestOverlap);

        // Filter out empty lines if they are just trailing newlines?
        // But sometimes empty lines are meaningful.
        // Let's filter only if the ONLY new content is empty lines (often artifacts of capture)
        const allEmpty = addedLines.every(l => l.trim().length === 0);
        if (allEmpty && addedLines.length > 0) {
            // Check if we really want to emit these.
            // If it's just one empty line, maybe not?
            // User wants streaming, so maybe yes.
            // But usually we trim() before emitting in the caller... wait.
            // The caller does: if (contentToEmit) { emit... }
            // Let's return joined.
        }

        if (addedLines.length === 0) return null;

        // Strip shell prompts for non-Claude/generic sessions only if specifically requested?
        // The user complained about missing output. The previous logic was too aggressive.
        // Let's keep ALL added lines. This is the safest way to ensure "streaming".

        return addedLines.join('\n');
    }

    private async checkHealth(): Promise<void> {
        try {
            const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"', { timeout: 10000, maxBuffer: 1024 * 1024 });
            const activeSessions = new Set(stdout.trim().split('\n'));

            for (const session of this.sessions.values()) {
                const tmuxSession = (session as TmuxSession).tmuxSession;
                const isAlive = activeSessions.has(tmuxSession);

                if (!isAlive && session.status !== 'offline') {
                    session.status = 'offline';
                    this.emit('status', {
                        sessionId: session.sessionId,
                        status: 'offline'
                    });
                }
            }
        } catch {
            // tmux not running
            for (const session of this.sessions.values()) {
                if (session.status !== 'offline') {
                    session.status = 'offline';
                }
            }
        }
    }
}
