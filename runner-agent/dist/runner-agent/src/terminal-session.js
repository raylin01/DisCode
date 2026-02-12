/**
 * Terminal Session Manager using node-pty
 *
 * Provides persistent interactive sessions with CLI tools (Claude, Gemini, etc.)
 * Uses node-pty for true PTY support - works with Claude CLI!
 */
import * as pty from 'node-pty';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import stripAnsi from 'strip-ansi';
export class TerminalSession extends EventEmitter {
    pty = null;
    sessionId;
    cliPath;
    cwd;
    cols;
    rows;
    env;
    outputBuffer = '';
    isReady = false;
    constructor(options) {
        super();
        this.sessionId = options.sessionId || randomUUID();
        this.cliPath = options.cliPath;
        this.cwd = options.cwd;
        this.cols = options.cols || 120;
        this.rows = options.rows || 40;
        this.env = {
            ...process.env,
            TERM: 'xterm-256color',
            FORCE_COLOR: '1',
            ...options.env
        };
    }
    /**
     * Start the terminal session
     */
    async start() {
        if (this.pty) {
            throw new Error('Session already started');
        }
        console.log(`[Terminal ${this.sessionId.slice(0, 8)}] Starting ${this.cliPath}...`);
        this.pty = pty.spawn(this.cliPath, [], {
            name: 'xterm-256color',
            cols: this.cols,
            rows: this.rows,
            cwd: this.cwd,
            env: this.env
        });
        console.log(`[Terminal ${this.sessionId.slice(0, 8)}] PID: ${this.pty.pid}`);
        // Handle data from the PTY
        this.pty.onData((data) => {
            this.handleData(data);
        });
        // Handle exit
        this.pty.onExit(({ exitCode, signal }) => {
            console.log(`[Terminal ${this.sessionId.slice(0, 8)}] Exited with code: ${exitCode}, signal: ${signal}`);
            this.emit('exit', { exitCode: exitCode || 0, signal });
            this.pty = null;
        });
        // Wait for CLI to be ready by detecting when output stops streaming
        await this.waitForStreamComplete();
    }
    /**
     * Wait for the CLI to finish its initial output stream
     * Detects when the terminal stops producing output for a certain time
     */
    async waitForStreamComplete() {
        return new Promise((resolve) => {
            let lastDataTime = Date.now();
            const STREAM_TIMEOUT = 1000; // 1 second of no output = ready
            // Store reference to update from handleData
            this.streamDetection = { lastDataTime, resolve };
        });
    }
    streamDetection = null;
    /**
     * Handle incoming data from the terminal
     */
    handleData(data) {
        // Update stream detection timestamp
        if (this.streamDetection && !this.isReady) {
            this.streamDetection.lastDataTime = Date.now();
            // Check if we should mark as ready
            const checkStream = () => {
                if (this.isReady)
                    return;
                const now = Date.now();
                if (now - this.streamDetection.lastDataTime >= 1000) {
                    // No data for 1 second - CLI is ready
                    console.log(`[Terminal ${this.sessionId.slice(0, 8)}] Ready! (stream stopped)`);
                    this.isReady = true;
                    this.emit('ready');
                    this.streamDetection.resolve();
                    this.streamDetection = null;
                }
                else {
                    // Check again in 100ms
                    setTimeout(checkStream, 100);
                }
            };
            // Start checking
            setTimeout(checkStream, 100);
        }
        this.outputBuffer += data;
        // Use strip-ansi and additional cleanup
        let clean = stripAnsi(data);
        // Additional cleanup for escape sequences strip-ansi might miss
        clean = clean
            // Remove remaining CSI sequences (Control Sequence Introducer)
            .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
            // Remove OSC sequences (Operating System Command)
            .replace(/\x1b\][0-9];[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
            // Remove remaining escape sequences
            .replace(/\x1b[PX^_][^\x1b]*\x1b\\/g, '')
            .replace(/\x1b\[[?\d;]*[hl]/g, '')
            // Remove carriage returns without newlines (terminal screen updates)
            .replace(/\r(?!\n)/g, '')
            // Remove bell character
            .replace(/\x07/g, '')
            // Remove remaining partial escape sequences like "53;153m"
            .replace(/^\d+(?:;\d+)*m/gm, '')
            .replace(/\[\??\d+[a-zA-Z]/g, '');
        const output = {
            raw: data,
            clean,
            timestamp: new Date(),
            isContent: this.isContentLine(clean)
        };
        this.emit('output', output);
    }
    /**
     * Determine if a line is actual content vs decorative terminal output
     */
    isContentLine(line) {
        const trimmed = line.trim();
        // Skip empty lines
        if (trimmed.length === 0)
            return false;
        // Skip decorative lines (box borders)
        if (trimmed.startsWith('─') || trimmed.startsWith('│') || trimmed.startsWith('╭') || trimmed.startsWith('╰'))
            return false;
        if (trimmed.match(/^[│┌┐└┘─┬┴├┤]+$/))
            return false;
        // Skip empty prompts
        if (trimmed === '>' || trimmed === '?')
            return false;
        // Skip help text
        if (trimmed === '? for shortcuts')
            return false;
        // Skip single character prompts
        if (trimmed.length < 2 && !/[a-zA-Z0-9]/.test(trimmed))
            return false;
        // Skip CPU warnings
        if (trimmed.includes('CPU lacks AVX'))
            return false;
        // Otherwise it's content
        return true;
    }
    /**
     * Send input to the terminal
     */
    write(text) {
        if (!this.pty) {
            throw new Error('Terminal not started');
        }
        this.pty.write(text);
    }
    /**
     * Send a message and press Enter
     * PTY expects Carriage Return (\r) for Enter key, not newline (\n)
     */
    sendMessage(message) {
        // Use \r (carriage return) which is what the Enter key sends in a terminal
        this.write(message + '\r');
    }
    /**
     * Resize the terminal
     */
    resize(cols, rows) {
        if (!this.pty) {
            throw new Error('Terminal not started');
        }
        this.pty.resize(cols, rows);
        this.cols = cols;
        this.rows = rows;
    }
    /**
     * Check if the session is running
     */
    isRunning() {
        return this.pty !== null;
    }
    /**
     * Get the session ID
     */
    getSessionId() {
        return this.sessionId;
    }
    /**
     * Get the current output buffer
     */
    getOutputBuffer() {
        return this.outputBuffer;
    }
    /**
     * Clear the output buffer
     */
    clearOutputBuffer() {
        this.outputBuffer = '';
    }
    /**
     * Kill the terminal session
     */
    kill() {
        if (this.pty) {
            console.log(`[Terminal ${this.sessionId.slice(0, 8)}] Killing...`);
            this.pty.kill();
            this.pty = null;
        }
    }
    /**
     * Close the terminal gracefully
     */
    async close() {
        if (this.pty) {
            // Send exit command if applicable
            try {
                this.write('/exit\r');
                // Wait briefly for graceful exit
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            catch {
                // Ignore errors during graceful close
            }
            if (this.pty) {
                this.kill();
            }
        }
    }
}
/**
 * Session Manager - manages multiple terminal sessions
 */
export class TerminalSessionManager {
    sessions = new Map();
    defaultCliPath;
    constructor(defaultCliPath) {
        this.defaultCliPath = defaultCliPath;
    }
    /**
     * Create a new terminal session
     */
    async createSession(cwd, sessionId, cliPath) {
        const session = new TerminalSession({
            cliPath: cliPath || this.defaultCliPath,
            cwd,
            sessionId
        });
        await session.start();
        this.sessions.set(session.getSessionId(), session);
        // Clean up when session exits
        session.on('exit', () => {
            this.sessions.delete(session.getSessionId());
        });
        return session;
    }
    /**
     * Get an existing session
     */
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    /**
     * List all active session IDs
     */
    listSessions() {
        return Array.from(this.sessions.keys());
    }
    /**
     * Close a specific session
     */
    async closeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.close();
            this.sessions.delete(sessionId);
        }
    }
    /**
     * Close all sessions
     */
    async closeAll() {
        const promises = Array.from(this.sessions.values()).map(s => s.close());
        await Promise.all(promises);
        this.sessions.clear();
    }
}
