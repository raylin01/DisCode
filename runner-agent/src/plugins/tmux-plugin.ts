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

import { execFile, exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import {
    BasePlugin,
    PluginSession,
    SessionConfig,
    SessionStatus,
    HookEvent,
    ApprovalOption
} from './base.js';
import { getPluginManager } from './plugin-manager.js';
import { getParser, type CliParser } from './parsers/index.js';
import { SkillManager } from '../utils/skill-manager.js';
import { getConfig } from '../config.js';
import { buildClaudeCliArgs } from '../utils/claude-cli-args.js';
import { resolveClaudeCommand } from '../utils/claude-cli-command.js';

// Import extracted modules
import { TmuxSession } from './tmux-session.js';
import {
    capturePane,
    detectPermissionPrompt,
    detectBypassWarning,
    parseTokensFromOutput,
    parseActivity,
    parseMode,
    detectShellPrompt,
    getNewContent
} from './tmux-io.js';
import { TmuxDiscovery } from './tmux-discovery.js';

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
// Helper Functions
// ============================================================================

function shortId(): string {
    return randomUUID().slice(0, 8);
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

    // Session discovery
    private discovery?: TmuxDiscovery;

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

        // Initialize discovery helper
        this.discovery = new TmuxDiscovery(this.tmuxPath, (msg) => this.log(msg));

        // Cleanup orphaned sessions from previous runs
        await this.discovery.cleanupOrphanedSessions();

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

    async shutdown(): Promise<void> {
        if (this.pollInterval) clearInterval(this.pollInterval);
        if (this.healthInterval) clearInterval(this.healthInterval);
        if (this.discovery) this.discovery.stopDiscovery();
        await super.shutdown();
    }

    async listSessions(): Promise<string[]> {
        if (this.discovery) {
            return this.discovery.listSessions();
        }
        // Fallback if discovery not initialized
        try {
            const { stdout } = await execFileAsync(this.tmuxPath, ['list-sessions', '-F', '#{session_name}']);
            return stdout.trim().split('\n').filter(s => s.length > 0);
        } catch (e) {
            return [];
        }
    }

    /**
     * Get the current working directory of a tmux session
     */
    async getSessionCwd(sessionId: string): Promise<string | null> {
        if (this.discovery) {
            return this.discovery.getSessionCwd(sessionId);
        }
        // Fallback
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
        if (!this.discovery) return;

        this.discovery.on('session_discovered', (info) => {
            // Only emit if we're not already managing this session
            if (!this.sessions.has(info.sessionId)) {
                this.emit('session_discovered', info);
            }
        });

        // Start discovery with skip check for sessions we already manage
        this.discovery.startDiscovery(5000, (sessionName) => {
            // Skip sessions we're already managing
            return this.sessions.has(sessionName);
        });
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
            const claudeArgs = buildClaudeCliArgs(config.options);
            const resolved = resolveClaudeCommand(config.cliPath, config.options);
            const allArgs = [...resolved.args, ...claudeArgs];
            cliCmd = allArgs.length > 0
                ? `${resolved.command} ${allArgs.join(' ')}`
                : resolved.command;
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
                const watched = Array.from(this.sessions.values()).filter(s => !(s as TmuxSession).isOwned);
                if (watched.length > 0) {
                    this.log(`[DEBUG] Polling ${this.sessions.size} sessions (${watched.length} watched)...`);
                }
            }

            for (const session of this.sessions.values()) {
                if (session.status !== 'offline') {
                    this.pollSession(session as TmuxSession);
                } else {
                    if (!(session as TmuxSession).isOwned) this.log(`[DEBUG] Watched session ${session.sessionId} is OFFLINE, skipping poll`);
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
                    output.includes('\u23FA') ||
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
                    const diff = getNewContent(session.lastOutput, cleaned, false);
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
                    // Claude Code prompt usually ends with ">" or standard prompt character
                    // We check the last line
                    const lastLine = cleaned.split('\n').pop() || '';
                    if (/^[>\u276F]\s*$/.test(lastLine) || cleaned.trim().endsWith('>') || cleaned.trim().endsWith('\u276F')) {
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
                const contentToEmit = getNewContent(session.lastOutput, cleaned, isCliSession);

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

    private async checkHealth(): Promise<void> {
        try {
            const activeSessions = this.discovery
                ? await this.discovery.getActiveSessions()
                : new Set<string>();

            // If no discovery, try directly
            if (activeSessions.size === 0 && !this.discovery) {
                const { stdout } = await execAsync('tmux list-sessions -F "#{session_name}"', {
                    timeout: 10000,
                    maxBuffer: 1024 * 1024
                });
                stdout.trim().split('\n').forEach(s => activeSessions.add(s));
            }

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
