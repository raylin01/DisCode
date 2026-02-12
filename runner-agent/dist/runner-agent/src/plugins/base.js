/**
 * CLI Plugin Base Interface
 *
 * Defines the contract for all CLI integration plugins.
 * Plugins handle the actual interaction with CLI tools (Claude, Gemini, etc.)
 */
import { EventEmitter } from 'events';
// ============================================================================
// Base Plugin Class
// ============================================================================
export class BasePlugin extends EventEmitter {
    sessions = new Map();
    async initialize() {
        console.log(`[${this.name}] Initializing...`);
    }
    async shutdown() {
        console.log(`[${this.name}] Shutting down...`);
        for (const session of this.sessions.values()) {
            await session.close();
        }
        this.sessions.clear();
    }
    getSession(sessionId) {
        return this.sessions.get(sessionId);
    }
    async destroySession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
            await session.close();
            this.sessions.delete(sessionId);
        }
    }
    getSessions() {
        return Array.from(this.sessions.values());
    }
    log(message) {
        console.log(`[${this.name}] ${message}`);
    }
    debug(message) {
        if (process.env.DEBUG) {
            console.log(`[${this.name}:debug] ${message}`);
        }
    }
}
