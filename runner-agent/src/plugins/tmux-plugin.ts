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
    ApprovalOption,
    OutputEvent,
    ApprovalEvent,
    StatusEvent,
    MetadataEvent,
    HookEvent,
} from './base.js'; // Use .js for implementation
import { getPluginManager } from './plugin-manager.js';

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

    async sendApproval(optionNumber: string): Promise<void> {
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
 */
function detectPermissionPrompt(output: string): { tool: string; context: string; options: ApprovalOption[] } | null {
    const lines = output.split('\n');

    // Look for "Do you want to proceed?" or "Would you like to proceed?"
    let proceedLineIdx = -1;
    // Scan last 50 lines (increased from 30)
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        if (/(Do you want|Would you like) to proceed/i.test(lines[i])) { // Removed ? to be safer
            proceedLineIdx = i;
            break;
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

    if (!hasFooter && !hasSelector) return null;

    // Parse numbered options
    const options: ApprovalOption[] = [];
    for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 10); i++) {
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

    if (options.length < 2) return null;

    // Find tool name
    let tool = 'Unknown';
    for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
        const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/);
        if (toolMatch) {
            tool = toolMatch[1];
            break;
        }
        const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i);
        if (cmdMatch) {
            tool = cmdMatch[1];
            break;
        }
    }

    // Build context
    const contextStart = Math.max(0, proceedLineIdx - 10);
    const contextEnd = proceedLineIdx + 1 + options.length;
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

    async initialize(): Promise<void> {
        await super.initialize();

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
        const pollingEnabled = process.env.DISCORDE_TMUX_POLLING !== 'false';
        if (pollingEnabled) {
            this.log('Starting session discovery polling...');
            this.startSessionDiscovery();
        } else {
            this.log('Session discovery polling disabled via DISCORDE_TMUX_POLLING=false');
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

    async watchSession(sessionId: string): Promise<PluginSession> {
        // Verify session exists
        const sessions = await this.listSessions();
        if (!sessions.includes(sessionId)) {
            throw new Error(`Session ${sessionId} not found`);
        }

        // Create a config for this watched session
        const config: SessionConfig = {
            cliPath: 'watched', // Placeholder
            cwd: '/', // Unknown, doesn't matter for watching
            sessionId: sessionId, // Use the tmux session name as our ID
            cliType: 'claude', // Default to claude for now, or maybe generic
            options: {
                continueConversation: true
            }
        };

        const session = new TmuxSession(config, sessionId, this.tmuxPath, false); // isOwned = false
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

                        // Ignore internal sessions (created by us)
                        if (session.startsWith('discode-')) {
                            continue;
                        }

                        // Don't emit for our own internal sessions if we just created them
                        // But wait, the bot needs to know about them? 
                        // The createSession flow handles owned sessions.
                        // We only care about EXTERNAL sessions or sessions we don't know about.

                        if (!this.sessions.has(session)) {
                            this.log(`Discovered new external session: ${session}`);
                            this.emit('session_discovered', {
                                sessionId: session,
                                exists: true
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
     * Create a new Claue CLI session in tmux
     */
    async createSession(config: SessionConfig): Promise<PluginSession> {
        const tmuxSession = `discode-${shortId()}`;

        // Build claude command
        const args: string[] = [];

        if (config.options?.continueConversation !== false) {
            // Vibecraft typically runs 'claude' without -c for interactive mode
            // '-c' might be interpreted as "continue last" which fails if none exists
            // Leaving args empty defaults to new/interactive session
            // args.push('-c'); 
        }
        if (config.options?.skipPermissions !== false) {
            args.push('--permission-mode=bypassPermissions');
            args.push('--dangerously-skip-permissions');
        }

        const claudeCmd = args.length > 0
            ? `${config.cliPath} ${args.join(' ')}`
            : config.cliPath;

        this.log(`Creating session: ${tmuxSession} with cmd: ${claudeCmd}`);

        // Wrap command in shell to keep pane open on failure for debugging
        // This ensures output is captured before the pane closes
        const safeCmd = `bash -c "${claudeCmd.replace(/"/g, '\\"')} || (echo 'Command failed with exit code $?'; echo 'Keeping pane open for debugging...'; sleep 60)"`;

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
            for (const session of this.sessions.values()) {
                if (session.status !== 'offline') {
                    this.pollSession(session as TmuxSession);
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
    }

    private async pollSession(session: TmuxSession): Promise<void> {
        try {
            const output = await capturePane(session.tmuxSession, 100, session.tmuxPath);

            // For watched sessions (not owned by us/Claude), use raw output (but strip ANSI for diffing clarity?)
            // Actually, we want to preserve layout but maybe strip colors for the text content check? 
            // Or better: use a less aggressive cleaner for watched sessions.
            let cleaned: string;

            // Detect if this is a Claude Code session (even if watched)
            // by looking for Claude Code markers in the raw output
            const isClaudeCodeSession = session.isOwned ||
                output.includes('Claude Code') ||
                output.includes('⏺') ||
                output.includes('Sonnet') ||
                output.includes('Opus');

            if (isClaudeCodeSession) {
                // Claude Code session: use aggressive cleaning to hide UI noise
                cleaned = cleanOutput(output);
            } else {
                // Generic terminal: minimal cleaning (just ANSI)
                cleaned = output.replace(/\x1b\[[0-9;]*[mGKH]/g, '') // Basic ANSI strip
                    .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
                    .trim();
            }

            // Startup Phase Handling
            if (session.isBooting()) {
                // If we see the prompt ">", we are ready
                // NOTE: We check 'output' (rawish) because 'cleanOutput' might now strip the prompt
                // But we should strip ANSI to be safe
                const rawStripped = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

                if (rawStripped.includes('>')) {
                    this.log(`Session ${session.sessionId} is ready (prompt detected)`);
                    session.setReady();

                    // Emit fake output to signal readiness cleanly
                    this.emit('output', {
                        sessionId: session.sessionId,
                        content: '✨ Claude Code Ready',
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
                const contentToEmit = this.getNewContent(session.lastOutput, cleaned, isClaudeCodeSession);

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

            // Emit metadata event only if something meaningful changed
            if (metadataChanged) {
                this.log(`Metadata: tokens=${session.lastTokenCount} activity=${session.currentActivity} mode=${session.currentMode}`);
                this.emit('metadata', {
                    sessionId: session.sessionId,
                    tokens: session.lastTokenCount || undefined,
                    cumulativeTokens: session.cumulativeTokens || undefined,
                    mode: session.currentMode,
                    activity: session.currentActivity,
                    timestamp: new Date()
                });
            }

        } catch (e) {
            // Session might be dead
            this.debug(`Poll failed for ${session.sessionId}: ${e}`);
        }
    }

    private getNewContent(oldOutput: string, newOutput: string, isClaudeCode: boolean = true): string | null {
        // Line-based diff approach that:
        // 1. Only emits lines that are NEW (not in old output)
        // 2. Filters out empty shell prompts
        // 3. Filters out prompt-only lines for terminals

        const oldLines = new Set(oldOutput.split('\n').map(l => l.trim()).filter(l => l.length > 0));
        const newLines = newOutput.split('\n');

        // Find lines that are new (not in old output)
        const newContentLines: string[] = [];

        for (const line of newLines) {
            const trimmed = line.trim();

            // Skip empty lines
            if (trimmed.length === 0) continue;

            // Skip if we've seen this exact line before
            if (oldLines.has(trimmed)) continue;

            // For non-Claude sessions, filter out shell prompt noise
            if (!isClaudeCode) {
                // Skip empty shell prompts: lines that are ONLY a prompt (end with $ and nothing after)
                // e.g., "(base) MacBook-Pro-183:~ ray$" with nothing typed
                if (/^.*\$\s*$/.test(trimmed)) {
                    continue;
                }

                // Skip bash prompt patterns with no command
                if (/^\([^)]+\)\s+\S+:\S*\s+\w+\$$/.test(trimmed)) {
                    continue;
                }

                // Skip zsh-style prompts
                if (/^[▸❯>\%]\s*$/.test(trimmed)) {
                    continue;
                }
            }

            newContentLines.push(trimmed);
        }

        // Return only if we have meaningful new content
        if (newContentLines.length === 0) {
            return null;
        }

        return newContentLines.join('\n');
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
