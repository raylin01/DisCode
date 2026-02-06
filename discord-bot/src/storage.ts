/**
 * YAML-based storage system for DisCode Discord Bot
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { TokenInfo, RunnerInfo, Session } from '../../shared/types.ts';

interface StorageData {
  users: Record<string, UserData>;
  runners: Record<string, RunnerInfo>;
  sessions: Record<string, Session>;
}

interface UserData {
  tokens: TokenInfo[];
  runners: string[]; // runner IDs owned by this user
}

const STORAGE_PATH = process.env.DISCODE_STORAGE_PATH || './data';
const USERS_FILE = path.join(STORAGE_PATH, 'users.yaml');
const RUNNERS_FILE = path.join(STORAGE_PATH, 'runners.yaml');
const SESSIONS_FILE = path.join(STORAGE_PATH, 'sessions.yaml');

class Storage {
  private _data: StorageData;

  constructor() {
    this._data = {
      users: {},
      runners: {},
      sessions: {}
    };
    this.ensureDirectories();
    this.load();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(STORAGE_PATH)) {
      fs.mkdirSync(STORAGE_PATH, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(USERS_FILE)) {
        const usersData = fs.readFileSync(USERS_FILE, 'utf-8');
        this._data.users = yaml.load(usersData) as Record<string, UserData>;
      }

      if (fs.existsSync(RUNNERS_FILE)) {
        const runnersData = fs.readFileSync(RUNNERS_FILE, 'utf-8');
        this._data.runners = yaml.load(runnersData) as Record<string, RunnerInfo>;

        // Clean up null values from authorizedUsers
        let cleaned = false;
        for (const runnerId in this._data.runners) {
          const runner = this._data.runners[runnerId];
          if (runner.authorizedUsers) {
            const originalLength = runner.authorizedUsers.length;
            runner.authorizedUsers = runner.authorizedUsers.filter((userId): userId is string => !!userId);
            if (runner.authorizedUsers.length !== originalLength) {
              cleaned = true;
              console.log(`Cleaned ${originalLength - runner.authorizedUsers.length} null values from runner ${runnerId}`);
            }
          }
        }

        // Save cleaned data
        if (cleaned) {
          this.saveRunners();
        }
      }

      if (fs.existsSync(SESSIONS_FILE)) {
        const sessionsData = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        this._data.sessions = yaml.load(sessionsData) as Record<string, Session>;
      }
    } catch (error) {
      console.error('Error loading storage:', error);
      // Start with empty data if files don't exist or are invalid
    }
  }

  private saveUsers(): void {
    const yamlStr = yaml.dump(this._data.users);
    fs.writeFileSync(USERS_FILE, yamlStr, 'utf-8');
  }

  private saveRunners(): void {
    const yamlStr = yaml.dump(this._data.runners);
    fs.writeFileSync(RUNNERS_FILE, yamlStr, 'utf-8');
  }

  private saveSessions(): void {
    const yamlStr = yaml.dump(this._data.sessions);
    fs.writeFileSync(SESSIONS_FILE, yamlStr, 'utf-8');
  }

  // Token operations
  generateToken(userId: string, guildId: string): TokenInfo {
    const user = this._data.users[userId] || { tokens: [], runners: [] };

    const token = this.generateRandomToken();
    const tokenInfo: TokenInfo = {
      token,
      userId,
      guildId,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      isActive: true
    };

    user.tokens.push(tokenInfo);
    this._data.users[userId] = user;
    this.saveUsers();

    return tokenInfo;
  }

  validateToken(token: string): TokenInfo | null {
    for (const userId in this._data.users) {
      const user = this._data.users[userId];
      const tokenInfo = user.tokens.find(t => t.token === token && t.isActive);

      if (tokenInfo) {
        // Update last used
        tokenInfo.lastUsed = new Date().toISOString();
        this.saveUsers();
        return tokenInfo;
      }
    }

    return null;
  }

  getUserTokens(userId: string): TokenInfo[] {
    const user = this._data.users[userId];
    return user?.tokens.filter(t => t.isActive) || [];
  }

  revokeToken(userId: string, token: string): boolean {
    const user = this._data.users[userId];
    if (!user) return false;

    const tokenInfo = user.tokens.find(t => t.token === token);
    if (!tokenInfo) return false;

    tokenInfo.isActive = false;
    this.saveUsers();
    return true;
  }

  // Runner operations
  registerRunner(runner: RunnerInfo): void {
    this._data.runners[runner.runnerId] = runner;

    // Add to owner's runners list (deduplicate)
    const user = this._data.users[runner.ownerId] || { tokens: [], runners: [] };
    if (!user.runners.includes(runner.runnerId)) {
      user.runners.push(runner.runnerId);
    }
    // Remove duplicates
    user.runners = [...new Set(user.runners)];
    this._data.users[runner.ownerId] = user;

    this.saveRunners();
    this.saveUsers();
  }

  deleteRunner(runnerId: string): void {
    const runner = this._data.runners[runnerId];
    if (!runner) return;

    // Remove from owner's runners list
    const user = this._data.users[runner.ownerId];
    if (user) {
      user.runners = user.runners.filter(id => id !== runnerId);
      this._data.users[runner.ownerId] = user;
    }

    // Remove from runners
    delete this._data.runners[runnerId];

    this.saveRunners();
    this.saveUsers();
  }

  getRunner(runnerId: string): RunnerInfo | null {
    return this._data.runners[runnerId] || null;
  }

  getUserRunners(userId: string): RunnerInfo[] {
    const user = this._data.users[userId];
    if (!user) return [];

    return user.runners
      .map(id => this._data.runners[id])
      .filter((r): r is RunnerInfo => r !== undefined);
  }

  updateRunnerStatus(runnerId: string, status: 'online' | 'offline'): void {
    const runner = this._data.runners[runnerId];
    if (runner) {
      runner.status = status;
      runner.lastHeartbeat = new Date().toISOString();
      this.saveRunners();
    }
  }

  updateRunner(runnerId: string, updates: Partial<RunnerInfo>): void {
    const runner = this._data.runners[runnerId];
    if (runner) {
      Object.assign(runner, updates);
      this.saveRunners();
    }
  }

  shareRunner(userId: string, runnerId: string, targetUserId: string): boolean {
    const runner = this.data.runners[runnerId];

    if (!runner || runner.ownerId !== userId) {
      return false;
    }

    if (!runner.authorizedUsers.includes(targetUserId)) {
      runner.authorizedUsers.push(targetUserId);
      this.saveRunners();
    }

    return true;
  }

  unshareRunner(userId: string, runnerId: string, targetUserId: string): boolean {
    const runner = this._data.runners[runnerId];

    if (!runner || runner.ownerId !== userId) {
      return false;
    }

    runner.authorizedUsers = runner.authorizedUsers.filter(id => id !== targetUserId);
    this.saveRunners();
    return true;
  }

  canUserAccessRunner(userId: string, runnerId: string): boolean {
    const runner = this._data.runners[runnerId];

    if (!runner) return false;
    if (runner.ownerId === userId) return true;
    if (runner.authorizedUsers.includes(userId)) return true;

    return false;
  }

  getRunnerForUser(userId: string): RunnerInfo | undefined {
      // Return the first runner owned by the user
      // Or we can check user.runners list
      const user = this._data.users[userId];
      if (user && user.runners.length > 0) {
          return this.getRunner(user.runners[0]) || undefined;
      }
      return undefined;
  }

  // Session operations
  createSession(session: Session): void {
    this._data.sessions[session.sessionId] = session;
    this.saveSessions();
  }

  getSession(sessionId: string): Session | null {
    return this._data.sessions[sessionId] || null;
  }

  /**
   * Find a session by short ID prefix (first 8 chars of UUID without dashes)
   * Used for matching tmux session names like discode-{shortId}
   */
  getSessionByShortId(shortId: string): Session | null {
    for (const sessionId in this._data.sessions) {
      // Compare first 8 chars of session ID (without dashes) to the short ID
      const sessionIdNoDashes = sessionId.replace(/-/g, '').slice(0, 8);
      if (sessionIdNoDashes === shortId) {
        return this._data.sessions[sessionId];
      }
    }
    return null;
  }

  getRunnerSessions(runnerId: string): Session[] {
    return Object.values(this._data.sessions)
      .filter(s => s.runnerId === runnerId && s.status === 'active');
  }

  endSession(sessionId: string): void {
    const session = this._data.sessions[sessionId];
    if (session) {
      session.status = 'ended';
      this.saveSessions();
    }
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    const session = this._data.sessions[sessionId];
    if (session) {
      Object.assign(session, updates);
      this.saveSessions();
    }
  }

  /**
   * Find sessions by thread ID, returns most recent first
   * Used for respawn-session to find previous session settings
   */
  getSessionsByThreadId(threadId: string): Session[] {
    return Object.values(this._data.sessions)
      .filter(s => s.threadId === threadId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  async cleanupOldSessions(): Promise<number> {
    const beforeCount = Object.keys(this._data.sessions).length;
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Remove ended sessions older than 24 hours
    for (const sessionId in this._data.sessions) {
      const session = this._data.sessions[sessionId];
      if (session.status === 'ended' && new Date(session.createdAt) < oneDayAgo) {
        delete this._data.sessions[sessionId];
      }
    }

    const afterCount = Object.keys(this._data.sessions).length;
    const cleanedCount = beforeCount - afterCount;

    if (cleanedCount > 0) {
      // Use async file write to avoid blocking
      await fs.promises.writeFile(SESSIONS_FILE, yaml.dump(this._data.sessions));
      console.log(`Cleaned up ${cleanedCount} old ended sessions`);
    }

    return cleanedCount;
  }

  private generateRandomToken(): string {
    // Generate a secure random token
    const crypto = require('crypto');
    return crypto.randomBytes(32).toString('hex');
  }

  // Getter for data (needed for accessing all runners)
  get data(): StorageData {
    return this._data;
  }
}

export const storage = new Storage();
export { Storage };
