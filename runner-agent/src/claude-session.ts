/**
 * Claude CLI Session Manager
 * Uses -p (print mode) with --session-id/--resume for conversation persistence
 * 
 * Features:
 * - Real-time streaming output via spawn
 * - Clean CPU warning removal
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';

export interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ClaudeResponse {
  content: string;
  success: boolean;
  error?: string;
  sessionId?: string;
}

export interface StreamUpdate {
  content: string;
  isComplete: boolean;
}

function cleanOutput(str: string): string {
  return str
    // Remove ANSI escape sequences
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
    .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
    // Remove CPU warning
    .replace(/warn: CPU lacks AVX support.*?\.zip\s*/gs, '')
    .replace(/\r\n/g, '\n')
    .trim();
}

export class ClaudeSession extends EventEmitter {
  private sessionId: string;
  private cwd: string;
  private cliPath: string;
  private messageHistory: ClaudeMessage[] = [];
  private currentProcess: ChildProcess | null = null;

  constructor(cliPath: string, cwd: string, sessionId?: string) {
    super();
    this.cliPath = cliPath;
    this.cwd = cwd;
    this.sessionId = sessionId || randomUUID();
  }

  /**
   * Send a message to Claude and get response with streaming
   * Uses -p mode with --session-id/--resume for conversation persistence
   * Emits 'stream' events for real-time updates
   */
  async sendMessage(message: string): Promise<ClaudeResponse> {
    const isFirstMessage = this.messageHistory.length === 0;

    console.log(`[Claude ${this.sessionId.slice(0, 8)}] ${isFirstMessage ? 'New' : 'Continue'}: "${message.substring(0, 50)}..."`);
    console.log(`[Claude ${this.sessionId.slice(0, 8)}] CLI Path: ${this.cliPath}`);
    console.log(`[Claude ${this.sessionId.slice(0, 8)}] CWD: ${this.cwd}`);

    // Build command for shell execution (simpler, more reliable)
    const sessionFlag = isFirstMessage
      ? `--session-id=${this.sessionId}`
      : `--resume ${this.sessionId}`;

    // Escape the message for shell
    const escapedMsg = message.replace(/'/g, "'\\''");
    const cmd = `${this.cliPath} -p ${sessionFlag} '${escapedMsg}'`;

    console.log(`[Claude ${this.sessionId.slice(0, 8)}] Full command: ${cmd.substring(0, 150)}...`);

    return new Promise((resolve, reject) => {
      let buffer = '';
      let stderrBuffer = '';
      const STREAM_THROTTLE_MS = 150;
      let lastStreamTime = 0;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let processExited = false;

      // Spawn via shell for proper argument handling
      this.currentProcess = spawn('/bin/bash', ['-lc', cmd], {
        cwd: this.cwd,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          FORCE_COLOR: '0',
          DISCODE_SESSION_ID: this.sessionId,
          DISCODE_RUNNER_ID: process.env.DISCODE_RUNNER_NAME || 'local-runner'
        }
      });

      console.log(`[Claude ${this.sessionId.slice(0, 8)}] Spawned PID: ${this.currentProcess.pid}`);

      const emitStreamUpdate = () => {
        const now = Date.now();
        if (now - lastStreamTime > STREAM_THROTTLE_MS) {
          lastStreamTime = now;
          const cleaned = cleanOutput(buffer);
          this.emit('stream', {
            sessionId: this.sessionId,
            content: cleaned,
            isComplete: false
          } as StreamUpdate);
        }
      };

      this.currentProcess.stdout?.on('data', (data) => {
        const chunk = data.toString();
        buffer += chunk;
        console.log(`[Claude ${this.sessionId.slice(0, 8)}] stdout: +${chunk.length} bytes (total: ${buffer.length})`);
        emitStreamUpdate();
      });

      this.currentProcess.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        console.log(`[Claude ${this.sessionId.slice(0, 8)}] stderr: ${chunk.substring(0, 100)}`);
        // Also add stderr to buffer for output
        buffer += chunk;
        emitStreamUpdate();
      });

      this.currentProcess.on('close', (code, signal) => {
        processExited = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.currentProcess = null;

        const cleaned = cleanOutput(buffer);

        console.log(`[Claude ${this.sessionId.slice(0, 8)}] Exit code: ${code}, signal: ${signal}, content: ${cleaned.length} bytes`);
        if (stderrBuffer) {
          console.log(`[Claude ${this.sessionId.slice(0, 8)}] Stderr was: ${stderrBuffer.substring(0, 200)}`);
        }

        // Add to history
        this.messageHistory.push({
          role: 'user',
          content: message,
          timestamp: new Date()
        });

        if (cleaned) {
          this.messageHistory.push({
            role: 'assistant',
            content: cleaned,
            timestamp: new Date()
          });
        }

        // Emit final stream update
        this.emit('stream', {
          sessionId: this.sessionId,
          content: cleaned,
          isComplete: true
        } as StreamUpdate);

        resolve({
          content: cleaned,
          success: code === 0,
          error: code !== 0 ? `Exit code ${code}${stderrBuffer ? ': ' + cleanOutput(stderrBuffer).substring(0, 200) : ''}` : undefined,
          sessionId: this.sessionId
        });
      });

      this.currentProcess.on('error', (err) => {
        processExited = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.currentProcess = null;
        console.error(`[Claude ${this.sessionId.slice(0, 8)}] Process error: ${err.message}`);
        reject(err);
      });

      // Timeout after 3 minutes (Claude can be slow)
      timeoutHandle = setTimeout(() => {
        if (!processExited && this.currentProcess) {
          console.error(`[Claude ${this.sessionId.slice(0, 8)}] Timeout! Buffer so far: ${buffer.substring(0, 200)}`);
          this.currentProcess.kill('SIGTERM');
          setTimeout(() => {
            if (this.currentProcess) {
              this.currentProcess.kill('SIGKILL');
            }
          }, 5000);
          this.currentProcess = null;
          reject(new Error(`Timeout waiting for Claude response (buffer: ${buffer.length} bytes)`));
        }
      }, 180000); // 3 minutes
    });
  }

  /**
   * Send approval response - NOT USED with -p mode
   * Kept for API compatibility
   */
  sendApproval(approved: boolean): void {
    console.log(`[Claude ${this.sessionId.slice(0, 8)}] sendApproval called but not applicable in -p mode`);
  }

  /**
   * Close the session
   */
  async close(): Promise<void> {
    if (this.currentProcess) {
      this.currentProcess.kill();
      this.currentProcess = null;
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getHistory(): ClaudeMessage[] {
    return [...this.messageHistory];
  }

  getCwd(): string {
    return this.cwd;
  }
}

// Factory for creating sessions
export class SessionManager {
  private cliPath: string;
  private sessions = new Map<string, ClaudeSession>();

  constructor(cliPath: string) {
    this.cliPath = cliPath;
  }

  createSession(cwd: string, sessionId?: string): ClaudeSession {
    const session = new ClaudeSession(this.cliPath, cwd, sessionId);
    this.sessions.set(session.getSessionId(), session);
    return session;
  }

  getSession(sessionId: string): ClaudeSession | undefined {
    return this.sessions.get(sessionId);
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.close();
    }
    this.sessions.delete(sessionId);
  }
}
